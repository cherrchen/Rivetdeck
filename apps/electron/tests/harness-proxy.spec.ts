import { EventEmitter } from 'node:events'
import type { MessagePortMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { HarnessProxy } from '../src/harness-proxy.ts'
import { HttpHarnessTransport } from '../src/harness/transport.ts'

class FakeWebSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING
  readonly send = vi.fn()
  readonly close = vi.fn(() => {
    this.readyState = WebSocket.CLOSING
  })

  finishClose(): void {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

function createPort(): { port: Pick<MessagePortMain, 'postMessage' | 'start' | 'close' | 'on'>; emitClose: () => void; emitMessage: (data: unknown) => void } {
  const emitter = new EventEmitter()
  const port = Object.assign(emitter, {
    postMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(() => { emitter.emit('close') }),
  })
  return {
    port,
    emitClose: () => { emitter.emit('close') },
    emitMessage: (data) => { emitter.emit('message', { data }) },
  }
}

describe('HarnessProxy', () => {
  it('accepts only loopback origins', () => {
    const proxy = new HarnessProxy()
    proxy.setOrigin('http://127.0.0.1:43127')
    expect(proxy.requireOrigin()).toBe('http://127.0.0.1:43127')
    expect(() => { proxy.setOrigin('http://example.com:80') }).toThrow(/non-loopback/)
  })

  it('maps renderer URLs onto the Harness origin', () => {
    const proxy = new HarnessProxy()
    proxy.setOrigin('http://127.0.0.1:43127/')
    expect(proxy.resolveHarnessUrl('dsh-electron://localhost/api/session.list')).toBe(
      'http://127.0.0.1:43127/api/session.list',
    )
    expect(proxy.resolveHarnessUrl('/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=1')).toBe(
      'http://127.0.0.1:43127/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=1',
    )
    expect(proxy.resolveHarnessUrl('dsh-electron://localhost//example.invalid/collect')).toBe(
      'http://127.0.0.1:43127/example.invalid/collect',
    )
  })

  it('keeps Host cookies on the loopback origin for scheme-relative renderer URLs', async () => {
    const requested: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      requested.push(String(input instanceof Request ? input.url : input))
      return new Response('{}', { status: 200 })
    })
    const proxy = new HarnessProxy(undefined, fetchMock)
    proxy.setOrigin('http://127.0.0.1:43127')
    Reflect.set(proxy, 'cookie', 'dsh-auth=FAKE-REVIEW-COOKIE')

    await proxy.request({
      url: 'dsh-electron://localhost//example.invalid/collect',
      method: 'POST',
      headers: {},
    })
    const proxied = await proxy.proxyRequest(new Request('dsh-electron://localhost//example.invalid/collect', {
      method: 'POST',
      body: '{}',
    }))
    await proxied.text()

    expect(requested).toEqual([
      'http://127.0.0.1:43127/example.invalid/collect',
      'http://127.0.0.1:43127/example.invalid/collect',
    ])
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { cookie: 'dsh-auth=FAKE-REVIEW-COOKIE' },
      redirect: 'manual',
    })
    const protocolRequest = fetchMock.mock.calls[1]?.[0]
    expect(protocolRequest).toBeInstanceOf(Request)
    expect((protocolRequest as Request).headers.get('cookie')).toBe('dsh-auth=FAKE-REVIEW-COOKIE')
  })

  it('exchanges the launch token and authenticates HTTP and WebSocket requests', async () => {
    const requests: Array<RequestInfo | URL> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      requests.push(input)
      if (requests.length === 1) {
        return new Response(null, {
          status: 303,
          headers: { 'set-cookie': 'dsh-auth=signed; Path=/; HttpOnly' },
        })
      }
      return new Response('{}', { status: 200 })
    })
    const socket = new FakeWebSocket()
    const createWebSocket = vi.fn(() => socket)
    const proxy = new HarnessProxy(createWebSocket, fetchMock)
    const transport = new HttpHarnessTransport(proxy)

    await transport.start('http://127.0.0.1:43127/?token=launch-token')
    await transport.request({ url: '/api/pluginInventory/list', method: 'POST', headers: {} })
    const { port } = createPort()
    transport.openStream('/api/remote.mux', port)

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL('http://127.0.0.1:43127/?token=launch-token'),
      { redirect: 'manual' },
    )
    const requestInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(requestInit.headers).toMatchObject({ cookie: 'dsh-auth=signed' })
    expect(createWebSocket).toHaveBeenCalledWith(
      new URL('ws://127.0.0.1:43127/api/remote.mux'),
      'dsh-auth=signed',
    )
    socket.finishClose()
    await transport.stop()
  })

  it('refuses stream open before the origin is ready', () => {
    const proxy = new HarnessProxy()
    expect(() => proxy.requireOrigin()).toThrow(/not ready/)
  })

  it('closes the Host WebSocket when the renderer port closes', async () => {
    const socket = new FakeWebSocket()
    const proxy = new HarnessProxy(() => socket)
    const { port, emitClose } = createPort()
    proxy.setOrigin('http://127.0.0.1:43127')
    proxy.openStream('/api/remote.mux', port)

    emitClose()
    expect(socket.close.mock.calls).toHaveLength(1)
    socket.finishClose()
    await proxy.stop()
  })

  it('forwards renderer text frames to the open Host WebSocket', () => {
    const socket = new FakeWebSocket()
    socket.readyState = WebSocket.OPEN
    const proxy = new HarnessProxy(() => socket)
    const { port, emitMessage } = createPort()
    proxy.setOrigin('http://127.0.0.1:43127')
    proxy.openStream('/api/remote.mux', port)

    emitMessage({ type: 'send', data: '{"type":"start"}' })

    expect(socket.send).toHaveBeenCalledWith('{"type":"start"}')
  })

  it('waits for active WebSockets to close when the transport stops', async () => {
    const socket = new FakeWebSocket()
    const proxy = new HarnessProxy(() => socket)
    const transport = new HttpHarnessTransport(proxy)
    const { port } = createPort()
    await transport.start('http://127.0.0.1:43127')
    transport.openStream('/api/remote.mux', port)

    let stopped = false
    const stopping = transport.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(socket.close.mock.calls).toHaveLength(1)
    expect(stopped).toBe(false)

    socket.finishClose()
    await stopping
    expect(stopped).toBe(true)
  })
})
