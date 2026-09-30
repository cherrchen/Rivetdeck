/**
 * Main-process compatibility proxy to the supervised dsh web loopback origin.
 * The renderer never receives this URL; only Main opens HTTP and WebSocket to it.
 */

import type { MessagePortMain } from 'electron'
import { WebSocket as NodeWebSocket } from 'ws'
import type { HostBootstrap, HostHttpRequest, HostHttpResponse, HostStreamPortMessage } from './bridge-types.ts'
import { extractHostBootstrap } from './bootstrap-extract.ts'

const EVENT_PATHS = new Set(['/api/remote.mux'])

interface HostWebSocket {
  readonly readyState: number
  close(): void
  send(data: string): void
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: { type: string; data?: unknown }) => void): void
}

type WebSocketFactory = (url: URL, cookie: string | undefined) => HostWebSocket

interface ActiveStream {
  stop(): Promise<void>
}

/** Owns the Harness origin and performs every Main→DSH network call. */
export class HarnessProxy {
  private origin: string | undefined
  private cookie: string | undefined
  private readonly createWebSocket: WebSocketFactory
  private readonly fetchImpl: typeof fetch
  private readonly activeStreams = new Set<ActiveStream>()

  /**
   * @param createWebSocket - Host WebSocket factory; injectable for lifecycle tests.
   * @param fetchImpl - Host HTTP implementation; injectable for authentication tests.
   */
  constructor(
    createWebSocket: WebSocketFactory = (url, cookie) => new NodeWebSocket(url, {
      headers: cookie === undefined ? undefined : { cookie },
    }),
    fetchImpl: typeof fetch = fetch,
  ) {
    this.createWebSocket = createWebSocket
    this.fetchImpl = fetchImpl
  }

  /**
   * Bind the ready loopback origin after harness startup.
   * @param origin - Validated `http://127.0.0.1:<port>` origin (no path).
   */
  setOrigin(origin: string): void {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`harness proxy: unsupported origin protocol ${url.protocol}`)
    }
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error(`harness proxy: refusing non-loopback origin ${origin}`)
    }
    this.origin = `${url.protocol}//${url.host}`
  }

  /**
   * Exchange an upstream launch token for the authority-bound browser cookie.
   * @param launchUrl - Validated readiness URL emitted by `dsh web`.
   */
  async authenticate(launchUrl: string): Promise<void> {
    const url = new URL(launchUrl)
    this.setOrigin(launchUrl)
    if (!url.searchParams.has('token')) return
    const response = await this.fetchImpl(url, { redirect: 'manual' })
    const setCookie = response.headers.get('set-cookie')
    if (response.status !== 303 || setCookie === null) {
      throw new Error(`harness proxy: authentication returned HTTP ${String(response.status)}`)
    }
    this.cookie = setCookie.split(';', 1)[0]
  }

  /** Absolute Harness origin, or throw when not ready. */
  requireOrigin(): string {
    if (this.origin === undefined) throw new Error('harness proxy: origin is not ready')
    return this.origin
  }

  /**
   * Fetch Host index HTML and extract the boot graph plus preload URLs.
   * @returns Bootstrap payload for the Electron renderer.
   */
  async getBootstrap(): Promise<HostBootstrap> {
    const response = await this.fetchImpl(this.requireOrigin() + '/', {
      headers: { accept: 'text/html', ...this.cookie === undefined ? {} : { cookie: this.cookie } },
    })
    if (!response.ok) {
      throw new Error(`harness proxy: bootstrap GET failed with HTTP ${String(response.status)}`)
    }
    return extractHostBootstrap(await response.text())
  }

  /**
   * Forward one unary HTTP request to the Harness origin.
   * @param init - Renderer request (URL resolved against the renderer origin).
   * @returns Plain response suitable for IPC.
   */
  async request(init: HostHttpRequest): Promise<HostHttpResponse> {
    const target = this.bindHarnessUrl(new URL(init.url, 'dsh-electron://localhost/'))
    const headers = { ...init.headers }
    delete headers.host
    delete headers.Host
    delete headers.origin
    delete headers.Origin
    delete headers.referer
    delete headers.Referer
    if (this.cookie !== undefined) headers.cookie = this.cookie
    const response = await this.fetchImpl(target, {
      method: init.method,
      headers,
      redirect: 'manual',
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })
    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: await response.text(),
    }
  }

  /**
   * Proxy a WHATWG Request (custom-scheme protocol handler) to Harness.
   * @param request - Incoming `dsh-electron://` request.
   * @returns Upstream response (streaming body preserved when present).
   */
  async proxyRequest(request: Request): Promise<Response> {
    const target = this.bindHarnessUrl(new URL(request.url))
    const headers = new Headers(request.headers)
    // Drop browser initiator markers: the Main process is the trusted client.
    // Forwarding `Origin: dsh-electron://localhost` would fail the Host fence
    // against `Host: 127.0.0.1:<port>`.
    headers.delete('host')
    headers.delete('origin')
    headers.delete('referer')
    headers.delete('sec-fetch-site')
    headers.delete('sec-fetch-mode')
    headers.delete('sec-fetch-dest')
    headers.delete('sec-fetch-user')
    if (this.cookie !== undefined) headers.set('cookie', this.cookie)
    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: 'manual',
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null) {
      Object.assign(init, { body: request.body, duplex: 'half' })
    }
    return await this.fetchImpl(new Request(target, init))
  }

  /**
   * Open a real Host WebSocket and bridge frames onto a renderer MessagePort.
   * @param path - `/api/remote.mux`.
   * @param port - MessagePort transferred from the preload bridge.
   */
  openStream(path: string, port: Pick<MessagePortMain, 'postMessage' | 'start' | 'close' | 'on'>): void {
    if (!EVENT_PATHS.has(path)) {
      port.postMessage({ type: 'error', message: `harness proxy: unsupported stream path ${path}` } satisfies HostStreamPortMessage)
      port.close()
      return
    }
    const wsUrl = new URL(path, this.requireOrigin())
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = this.createWebSocket(wsUrl, this.cookie)
    let closing = false
    let finished = false
    let resolveDone: (() => void) | undefined
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })

    const finish = (): void => {
      if (finished) return
      finished = true
      this.activeStreams.delete(stream)
      resolveDone?.()
    }

    const closePort = (): void => {
      try {
        port.close()
      } catch {
        // The renderer already closed this MessagePort.
      }
    }

    const shutdown = (): Promise<void> => {
      if (closing) return done
      closing = true
      closePort()
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close()
        } else {
          finish()
        }
      } catch {
        // A failed close means the WebSocket implementation already released the socket.
        finish()
      }
      return done
    }

    const stream: ActiveStream = { stop: shutdown }
    this.activeStreams.add(stream)

    socket.addEventListener('open', () => {
      port.postMessage({ type: 'open' } satisfies HostStreamPortMessage)
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        port.postMessage({
          type: 'error',
          message: 'harness proxy: binary WebSocket frame',
        } satisfies HostStreamPortMessage)
        return
      }
      port.postMessage({ type: 'message', data: event.data } satisfies HostStreamPortMessage)
    })
    socket.addEventListener('close', () => {
      if (!closing) {
        port.postMessage({ type: 'close' } satisfies HostStreamPortMessage)
      }
      closing = true
      closePort()
      finish()
    })
    socket.addEventListener('error', () => {
      port.postMessage({
        type: 'error',
        message: `harness proxy: WebSocket error on ${path}`,
      } satisfies HostStreamPortMessage)
      void shutdown()
    })

    port.on('message', (event) => {
      const data = event.data as HostStreamPortMessage
      if (data.type === 'send') {
        if (socket.readyState !== WebSocket.OPEN) {
          port.postMessage({ type: 'error', message: 'harness proxy: send before WebSocket open' } satisfies HostStreamPortMessage)
          return
        }
        socket.send(data.data)
      } else if (data.type === 'abort') {
        void shutdown()
      }
    })
    port.on('close', () => { void shutdown() })
    port.start()
  }

  /** Close every active Host stream and wait for the WebSockets to finish. */
  async stop(): Promise<void> {
    await Promise.all([...this.activeStreams].map(stream => stream.stop()))
  }

  /**
   * Map a renderer URL onto the Harness origin.
   * @param url - Absolute `dsh-electron://` URL or path.
   * @returns Absolute Harness URL.
   */
  resolveHarnessUrl(url: string): string {
    return this.bindHarnessUrl(new URL(url, 'dsh-electron://localhost/')).href
  }

  /**
   * Copy path and query onto the ready loopback origin.
   * Scheme-relative paths such as `//host/path` must not become a new authority.
   * @param resource - Incoming renderer or custom-scheme URL.
   * @returns Absolute Harness URL whose origin equals the ready origin.
   */
  private bindHarnessUrl(resource: URL): URL {
    const origin = this.requireOrigin()
    const expected = new URL(origin)
    const target = new URL(origin)
    const pathname = resource.pathname.startsWith('/') ? resource.pathname : `/${resource.pathname}`
    target.pathname = pathname.replace(/^\/{2,}/u, '/')
    target.search = resource.search
    if (target.origin !== expected.origin) {
      throw new Error(`harness proxy: refusing non-origin URL ${target.origin}`)
    }
    return target
  }
}
