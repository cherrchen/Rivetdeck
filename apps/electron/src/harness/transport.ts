/**
 * Main-side Harness transport. Milestone 2 keeps the HTTP compatibility
 * implementation; a future process-IPC carrier can replace it without
 * changing the renderer bridge.
 */

import type { MessagePortMain } from 'electron'
import type { HostBootstrap, HostHttpRequest, HostHttpResponse } from '../bridge-types.ts'
import { HarnessProxy } from '../harness-proxy.ts'

/** Lifecycle and request API between Electron Main and the DSH Host process. */
export interface HarnessTransport {
  /** Bind the ready Host origin (HTTP compatibility) or start an IPC session. */
  start(origin: string): Promise<void>
  /** Release transport resources before Host shutdown. */
  stop(): Promise<void>
  /** Fetch Host bootstrap for the Electron renderer. */
  getBootstrap(): Promise<HostBootstrap>
  /** Unary Host request. */
  request(init: HostHttpRequest): Promise<HostHttpResponse>
  /** Open a Host event stream onto a transferred MessagePort. */
  openStream(path: '/api/remote.mux', port: Pick<MessagePortMain, 'postMessage' | 'start' | 'close' | 'on'>): void
  /** Absolute Harness origin when the HTTP carrier is active. */
  requireOrigin(): string
}

/** Loopback HTTP/WebSocket transport wrapping {@link HarnessProxy}. */
export class HttpHarnessTransport implements HarnessTransport {
  private readonly proxy: HarnessProxy

  /**
   * @param proxy - Existing Main-process Harness proxy instance.
   */
  constructor(proxy: HarnessProxy = new HarnessProxy()) {
    this.proxy = proxy
  }

  /** Underlying proxy used by the custom-scheme protocol handler. */
  get harnessProxy(): HarnessProxy {
    return this.proxy
  }

  /**
   * @param origin - Validated loopback origin from harness readiness.
   */
  async start(origin: string): Promise<void> {
    await this.proxy.authenticate(origin)
  }

  async stop(): Promise<void> {
    await this.proxy.stop()
  }

  getBootstrap(): Promise<HostBootstrap> {
    return this.proxy.getBootstrap()
  }

  request(init: HostHttpRequest): Promise<HostHttpResponse> {
    return this.proxy.request(init)
  }

  openStream(path: '/api/remote.mux', port: Pick<MessagePortMain, 'postMessage' | 'start' | 'close' | 'on'>): void {
    this.proxy.openStream(path, port)
  }

  requireOrigin(): string {
    return this.proxy.requireOrigin()
  }
}
