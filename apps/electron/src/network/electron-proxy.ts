import type { App, ProxyConfig, Session } from 'electron'
import type { DesktopNetworkMode } from './domain.ts'
import type { DesktopGatewayEndpoint } from './environment.ts'

type ProxySession = Pick<Session, 'setProxy' | 'closeAllConnections'>

/** Applies one Desktop route to Chromium's app and every registered Session. */
export class ElectronProxyApplier {
  private readonly sessions = new Set<ProxySession>()
  private readonly updaterSessions = new Set<ProxySession>()
  private config: ProxyConfig | undefined
  private updaterConfig: ProxyConfig | undefined

  constructor(private readonly application: Pick<App, 'setProxy'>, defaultSession: ProxySession) {
    this.sessions.add(defaultSession)
  }

  /** Register a Session before its first request. @returns a disposer for its ownership. */
  async register(session: ProxySession, purpose: 'general' | 'updater' = 'general'): Promise<() => void> {
    const owned = purpose === 'updater' ? this.updaterSessions : this.sessions
    owned.add(session)
    try {
      const config = purpose === 'updater' ? this.updaterConfig : this.config
      if (config !== undefined) await session.setProxy(config)
    } catch (error) {
      owned.delete(session)
      throw error
    }
    return () => { owned.delete(session) }
  }

  /** Default leaves Chromium's existing configuration untouched. */
  async apply(mode: DesktopNetworkMode, gateway?: DesktopGatewayEndpoint, updaterGateway?: DesktopGatewayEndpoint): Promise<void> {
    if (mode === 'default') return
    const config: ProxyConfig = mode === 'direct'
      ? { mode: 'direct' }
      : { mode: 'fixed_servers', proxyRules: gatewayRule(gateway) }
    const updaterConfig: ProxyConfig = mode === 'direct'
      ? { mode: 'direct' }
      : { mode: 'fixed_servers', proxyRules: gatewayRule(updaterGateway) }
    await this.application.setProxy(config)
    await Promise.all([...this.sessions].map(async (owned) => { await owned.setProxy(config) }))
    await Promise.all([...this.updaterSessions].map(async (owned) => { await owned.setProxy(updaterConfig) }))
    this.config = config
    this.updaterConfig = updaterConfig
    await this.closeConnections()
  }

  /** Close pooled Chromium connections after System policy changes. */
  async closeConnections(): Promise<void> {
    await Promise.all([...this.sessions, ...this.updaterSessions].map(async (owned) => { await owned.closeAllConnections() }))
  }
}

function gatewayRule(gateway: DesktopGatewayEndpoint | undefined): string {
  if (gateway === undefined || !Number.isInteger(gateway.port) || gateway.port < 1 || gateway.port > 65_535) {
    throw new Error('desktop network: managed Electron proxy requires a ready Gateway')
  }
  const host = gateway.host === '::1' ? '[::1]' : gateway.host
  return `http://${host}:${String(gateway.port)}`
}
