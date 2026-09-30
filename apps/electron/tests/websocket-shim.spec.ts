// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeepseekDesktopBridge, HostStreamHandlers } from '../src/bridge-types.ts'
import {
  DESKTOP_WS_CLOSED,
  DESKTOP_WS_CONNECTING,
  DESKTOP_WS_OPEN,
  installDesktopWebSocket,
} from '../src/renderer/transport/websocket-shim.ts'

describe('desktop WebSocket stand-in', () => {
  const originalWebSocket = globalThis.WebSocket

  afterEach(() => {
    vi.unstubAllGlobals()
    globalThis.WebSocket = originalWebSocket
    delete globalThis.window.deepseekDesktop
  })

  it('bridges Host event paths through openStream callbacks (not a returned MessagePort)', () => {
    let captured: HostStreamHandlers | undefined
    const close = vi.fn()
    const send = vi.fn()
    const bridge = {
      host: {
        openStream: (_path: '/api/remote.mux', handlers: HostStreamHandlers) => {
          captured = handlers
          return { close, send }
        },
      },
    } satisfies { host: Pick<DeepseekDesktopBridge['host'], 'openStream'> }
    Object.defineProperty(globalThis.window, 'deepseekDesktop', { configurable: true, value: bridge })
    installDesktopWebSocket()

    const socket = new WebSocket('dsh-electron://localhost/api/remote.mux')
    expect(socket.readyState).toBe(DESKTOP_WS_CONNECTING)
    expect(captured).toBeDefined()

    const opens: Event[] = []
    const messages: MessageEvent[] = []
    socket.addEventListener('open', (event) => { opens.push(event) })
    socket.addEventListener('message', (event) => { messages.push(event) })

    captured!.onOpen()
    expect(socket.readyState).toBe(DESKTOP_WS_OPEN)
    expect(opens).toHaveLength(1)

    socket.send('{"type":"start"}')
    expect(send).toHaveBeenCalledWith('{"type":"start"}')

    captured!.onMessage('{"type":"ping"}')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.data).toBe('{"type":"ping"}')

    socket.close()
    expect(close).toHaveBeenCalledOnce()
    expect(socket.readyState).toBe(DESKTOP_WS_CLOSED)
  })

  it('emits error and close when openStream throws', async () => {
    Object.defineProperty(globalThis.window, 'deepseekDesktop', { configurable: true, value: {
      host: {
        openStream: () => {
          throw new Error('bridge unavailable')
        },
      },
    } satisfies { host: Pick<DeepseekDesktopBridge['host'], 'openStream'> } })
    installDesktopWebSocket()

    const socket = new WebSocket('dsh-electron://localhost/api/remote.mux')
    const events: string[] = []
    socket.addEventListener('error', () => { events.push('error') })
    socket.addEventListener('close', () => { events.push('close') })
    await vi.waitFor(() => {
      expect(events).toEqual(['error', 'close'])
    })
    expect(socket.readyState).toBe(DESKTOP_WS_CLOSED)
  })

  it('returns a native WebSocket for non-Host URLs so send and readyState work', async () => {
    const sent = vi.fn()
    class FakeNativeWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      url: string
      readyState = FakeNativeWebSocket.CONNECTING
      readonly send = sent
      readonly close = vi.fn()
      readonly addEventListener = vi.fn()
      readonly removeEventListener = vi.fn()
      constructor(url: string) {
        this.url = url
        queueMicrotask(() => {
          this.readyState = FakeNativeWebSocket.OPEN
        })
      }
    }
    vi.stubGlobal('WebSocket', FakeNativeWebSocket)
    Object.defineProperty(globalThis.window, 'deepseekDesktop', { configurable: true, value: {
      host: { openStream: vi.fn() },
    } satisfies { host: Pick<DeepseekDesktopBridge['host'], 'openStream'> } })
    installDesktopWebSocket()

    const socket = new WebSocket('ws://127.0.0.1:9/plugin-socket')
    expect(socket).toBeInstanceOf(FakeNativeWebSocket)
    await vi.waitFor(() => {
      expect(socket.readyState).toBe(FakeNativeWebSocket.OPEN)
    })
    socket.send('hello')
    expect(sent).toHaveBeenCalledWith('hello')
  })
})
