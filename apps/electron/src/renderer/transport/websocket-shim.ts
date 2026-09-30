/**
 * Renderer WebSocket stand-in for Host event streams.
 * Unmodified WebApiClient opens `ws://…/api/remote.mux`; custom schemes cannot
 * carry native WebSockets, so those paths ride preload-owned MessagePort →
 * Main → real WS (callbacks cross contextBridge; MessagePort does not).
 */

import type { HostStreamHandle, HostStreamHandlers } from '../../bridge-types.ts'

const EVENT_PATHS = new Set(['/api/remote.mux'])

export const DESKTOP_WS_CONNECTING = 0
export const DESKTOP_WS_OPEN = 1
export const DESKTOP_WS_CLOSING = 2
export const DESKTOP_WS_CLOSED = 3

/**
 * Install a global `WebSocket` that bridges Host event paths through the desktop IPC port.
 */
export function installDesktopWebSocket(): void {
  const native = Reflect.get(globalThis, 'WebSocket') as typeof WebSocket | undefined
  const bridge = globalThis.window.deepseekDesktop
  if (bridge === undefined) {
    throw new Error('desktop websocket: window.deepseekDesktop is missing')
  }

  const StandIn = function DesktopWebSocket(
    this: unknown,
    url: string | URL,
    protocols?: string | string[],
  ) {
    const parsed = new URL(String(url), globalThis.location.origin)
    if (!EVENT_PATHS.has(parsed.pathname)) {
      if (native === undefined) throw new Error(`desktop websocket: no native WebSocket for ${String(url)}`)
      return protocols === undefined ? new native(url) : new native(url, protocols)
    }
    return new DesktopWebSocketImpl(String(url), bridge)
  }

  Object.defineProperties(StandIn, {
    CONNECTING: { value: native?.CONNECTING ?? DESKTOP_WS_CONNECTING },
    OPEN: { value: native?.OPEN ?? DESKTOP_WS_OPEN },
    CLOSING: { value: native?.CLOSING ?? DESKTOP_WS_CLOSING },
    CLOSED: { value: native?.CLOSED ?? DESKTOP_WS_CLOSED },
  })
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: StandIn })
}

class DesktopWebSocketImpl {
  url: string
  readyState = DESKTOP_WS_CONNECTING
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  private stream: HostStreamHandle | undefined

  constructor(
    url: string,
    bridge: NonNullable<Window['deepseekDesktop']>,
  ) {
    this.url = url
    const parsed = new URL(url, globalThis.location.origin)
    const path = parsed.pathname as '/api/remote.mux'
    this.open(path, bridge)
  }

  close(): void {
    if (this.readyState === DESKTOP_WS_CLOSING || this.readyState === DESKTOP_WS_CLOSED) return
    this.readyState = DESKTOP_WS_CLOSING
    const stream = this.stream
    this.stream = undefined
    stream?.close()
    this.readyState = DESKTOP_WS_CLOSED
    this.emit('close', new CloseEvent('close'))
  }

  send(data: string): void {
    if (this.readyState !== DESKTOP_WS_OPEN || this.stream === undefined) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError')
    }
    this.stream.send(data)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener)
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener.call(this, event)
      else listener.handleEvent(event)
    }
  }

  private open(
    path: '/api/remote.mux',
    bridge: NonNullable<Window['deepseekDesktop']>,
  ): void {
    const handlers: HostStreamHandlers = {
      onOpen: () => {
        this.readyState = DESKTOP_WS_OPEN
        this.emit('open', new Event('open'))
      },
      onMessage: (data) => {
        this.emit('message', new MessageEvent('message', { data }))
      },
      onClose: () => {
        this.stream = undefined
        if (this.readyState === DESKTOP_WS_CLOSED) return
        this.readyState = DESKTOP_WS_CLOSED
        this.emit('close', new CloseEvent('close'))
      },
      onError: () => {
        this.stream = undefined
        this.emit('error', new Event('error'))
        if (this.readyState === DESKTOP_WS_CLOSED) return
        this.readyState = DESKTOP_WS_CLOSED
        this.emit('close', new CloseEvent('close'))
      },
    }
    try {
      this.stream = bridge.host.openStream(path, handlers)
    } catch {
      // Defer so callers can attach listeners after `new WebSocket(...)`.
      queueMicrotask(() => {
        this.readyState = DESKTOP_WS_CLOSED
        this.emit('error', new Event('error'))
        this.emit('close', new CloseEvent('close'))
      })
    }
  }
}
