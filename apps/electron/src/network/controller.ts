import { randomUUID } from 'node:crypto'
import type { DesktopNetworkPreferencesV1 } from '../preferences.ts'
import { DesktopPreferencesStore } from '../preferences.ts'
import type {
  DesktopNetworkConfigInput,
  DesktopNetworkDiagnostics,
  DesktopNetworkIncidentSummary,
  DesktopNetworkReloadResult,
  DesktopNetworkRetryResult,
  DesktopNetworkState,
  DesktopNetworkTestRequest,
  DesktopNetworkTestResult,
  ProxyCredentialChallenge,
  ProxyCredentialSubmission,
  PasswordChange,
  PersistedAuthenticatedProxy,
  PersistedManualProxy,
  SanitizedManualProxy,
} from './domain.ts'
import { MANUAL_PROXY_PASSWORD_REF } from './domain.ts'
import { NetworkEpochManager } from './epoch.ts'
import { classifyNetworkFailure } from './failure.ts'
import { NetworkIncidentManager } from './incidents.ts'
import {
  agentProxyPolicyForHost,
  environmentForAgent,
  environmentForHarnessLaunch,
  environmentForOwnedChild,
  type DesktopGatewayEndpoint,
  type NetworkEnvironmentPolicy,
} from './environment.ts'
import type { DesktopSecretStore } from './secret-store.ts'
import { consumeNetworkStartupOverride } from './startup-override.ts'
import { writeDefaultStartupOverride } from './startup-override.ts'
import { normalizeNetworkConfigInput } from './validation.ts'
import type { NetworkRuntimeClient } from './runtime-client.ts'
import type { NetworkRuntimeObservation } from './runtime-client.ts'
import { DesktopNetworkOperationError } from './errors.ts'
import type { RuntimeSystemSnapshot } from './runtime-protocol.ts'
import { runNetworkTests, type NetworkDiagnosticFetch } from './test-service.ts'

type ControllerRuntime = Pick<NetworkRuntimeClient,
  'start' | 'configure' | 'diagnostics' | 'getSystemSnapshot' | 'reloadSystem' | 'submitCredential' | 'onEvent' | 'shutdown'>

/** Dependencies that keep the controller independent of Electron globals. */
export interface DesktopNetworkControllerOptions {
  userDataPath: string
  preferences: DesktopPreferencesStore
  secrets: DesktopSecretStore
  relaunch: () => Promise<void>
  onIncident?: (incident: DesktopNetworkIncidentSummary) => void
  onEpochChanged?: () => void
  onCredentialRequired?: (challenge: ProxyCredentialChallenge) => void
  diagnosticFetch?: NetworkDiagnosticFetch
}

/** Main-owned lifecycle, policy generation, credential, and incident authority. */
export class DesktopNetworkController {
  private current: DesktopNetworkState | undefined
  private gateway: DesktopGatewayEndpoint | undefined
  private updaterGateway: DesktopGatewayEndpoint | undefined
  private runtime: ControllerRuntime | undefined
  private readonly epochs = new NetworkEpochManager()
  private readonly incidents = new NetworkIncidentManager()
  private lastRoute: DesktopNetworkIncidentSummary['route']
  private credentialPrompted = false
  private pendingChallenge: ProxyCredentialChallenge | undefined
  private reloadingSystem = false
  private readonly listeners = new Set<(state: DesktopNetworkState) => void>()

  /** @param options - Main-owned persistence, secret, and lifecycle services. */
  constructor(private readonly options: DesktopNetworkControllerOptions) {}

  /** Load preferences, consume a one-shot override, and publish sanitized state. */
  async prepare(): Promise<void> {
    const loaded = this.options.preferences.load()
    const oneShot = await consumeNetworkStartupOverride(this.options.userDataPath)
    const secureStorage = await this.options.secrets.status()
    const configuredMode = loaded.preferences.network.mode
    const effectiveMode = oneShot.override?.mode ?? configuredMode
    this.setCurrent({
      configuredMode,
      effectiveMode,
      ...(oneShot.override === undefined ? {} : { startupOverride: oneShot.override.mode }),
      ...sanitizedManualFields(loaded.preferences.network.manual, configuredMode === 'manual'),
      proxyAgentTraffic: loaded.preferences.network.proxyAgentTraffic,
      restartRequired: false,
      ...(loaded.warning === undefined ? {} : { preferencesWarning: loaded.warning }),
      runtime: { status: 'inactive' },
      secureStorage,
      testSettings: loaded.preferences.network.tests,
    })
    if (oneShot.warning !== undefined) console.warn(oneShot.warning)
  }

  /** @returns immutable sanitized state after {@link prepare}. */
  state(): DesktopNetworkState {
    if (this.current === undefined) throw new Error('desktop network: controller is not prepared')
    return structuredClone(this.current)
  }

  /** Receive sanitized state changes, including epoch and incident changes. */
  subscribe(listener: (state: DesktopNetworkState) => void): () => void {
    this.listeners.add(listener)
    if (this.current !== undefined) listener(this.state())
    return () => { this.listeners.delete(listener) }
  }

  /** Ask the mounted Desktop settings page to show Network for the current incident. */
  requestOpenSettings(): void {
    this.setCurrent({ ...this.state(), openSettingsRequestId: randomUUID() })
  }

  private setCurrent(state: DesktopNetworkState): void {
    this.current = state
    for (const listener of this.listeners) listener(this.state())
  }

  /** @returns sanitized runtime policy and failure diagnostics. */
  async diagnostics(): Promise<DesktopNetworkDiagnostics> {
    const state = this.state()
    let system: RuntimeSystemSnapshot | undefined
    if (state.effectiveMode === 'system' && this.runtime !== undefined && state.runtime.status === 'ready') {
      try { system = (await this.runtime.diagnostics()).system }
      catch { /* Runtime status and last failure remain visible after a diagnostic read fails. */ }
    }
    return {
      mode: state.effectiveMode,
      ...(state.epoch === undefined ? {} : { epoch: state.epoch }),
      runtime: { status: state.runtime.status,
        ...(state.runtime.gateway === undefined ? {} : { gateway: `http://${state.runtime.gateway.host}:${state.runtime.gateway.port}` }) },
      ...(system === undefined ? {} : { system: {
        backend: system.backend, policySource: system.policySource,
        ...(system.selectedRoute === undefined ? {} : { selectedRoute: system.selectedRoute }),
        alternativeRoutes: system.alternativeRoutes, pac: system.pac,
        policyFingerprint: system.policyFingerprint,
        ...(system.error === undefined ? {} : { error: system.error }),
      } }),
      ...(state.lastIncident === undefined ? {} : { lastFailure: state.lastIncident }),
    }
  }

  /** Run user-requested probes without creating proxy incidents or changing the epoch. */
  async test(request: DesktopNetworkTestRequest): Promise<DesktopNetworkTestResult> {
    const fetchOne = this.options.diagnosticFetch
    if (fetchOne === undefined) throw new Error('desktop network: diagnostic transport is unavailable')
    const state = this.state()
    const manualRoute = state.effectiveMode === 'manual' && state.manual !== undefined
      ? { kind: state.manual.protocol, host: state.manual.host, port: state.manual.port, source: 'manual' as const }
      : undefined
    const routeForTest = state.effectiveMode === 'manual' ? () => Promise.resolve(manualRoute)
      : state.effectiveMode === 'system' ? async () => (await this.diagnostics()).system?.selectedRoute
        : undefined
    return await runNetworkTests(request, state.testSettings, fetchOne, routeForTest)
  }

  /** Start the native Gateway before any managed Desktop or Harness request can run. */
  async startRuntime(runtime: ControllerRuntime): Promise<void> {
    const state = this.state()
    if (state.effectiveMode === 'default' || state.effectiveMode === 'direct') return
    this.setCurrent({ ...state, runtime: { status: 'starting' } })
    this.runtime = runtime
    runtime.onEvent((event) => { this.receiveRuntimeEvent(event) })
    try {
      const hello = await runtime.start()
      const configured = this.options.preferences.load().preferences.network
      if (state.effectiveMode === 'manual') {
        const proxy = configured.manual
        if (proxy === undefined) throw new Error('desktop network: Manual proxy is missing')
        let password: string | undefined
        if (proxy.protocol !== 'socks5' && proxy.credentialRef !== undefined) {
          try { password = await this.options.secrets.get(proxy.credentialRef) }
          catch { password = undefined }
        }
        await runtime.configure({
          mode: 'manual', strictFallback: true,
          proxy: proxy.protocol === 'socks5' ? proxy : {
            protocol: proxy.protocol, host: proxy.host, port: proxy.port,
            ...(proxy.username === undefined ? {} : { username: proxy.username }),
            ...(password === undefined ? {} : { password }),
          },
        })
      } else {
        await runtime.configure({ mode: 'system', strictFallback: true })
      }
      this.setGateway(hello.gateway)
      this.updaterGateway = hello.updaterGateway
      this.setCurrent({ ...this.state(), runtime: {
        status: 'ready', gateway: hello.gateway,
        protocolVersion: hello.protocolVersion,
        systemBackend: hello.systemBackend,
        capabilities: hello.capabilities,
      } })
      let snapshot: RuntimeSystemSnapshot | undefined
      if (state.effectiveMode === 'system') {
        try { snapshot = await runtime.getSystemSnapshot() }
        catch { /* An unreadable policy remains fail closed until real traffic or reload. */ }
      }
      this.beginEpoch('startup', snapshot)
    } catch (error) {
      this.setCurrent({ ...this.state(), runtime: { status: 'failed' } })
      await runtime.shutdown()
      throw error
    }
  }

  /** Stop the Gateway after its consumers have drained. */
  async shutdown(): Promise<void> {
    await this.runtime?.shutdown()
    if (this.current !== undefined) this.setCurrent({ ...this.current, runtime: { status: 'stopped' } })
  }

  /** Re-read System policy, invalidate old tunnels, and create a fresh user epoch. */
  async reloadSystemProxy(): Promise<DesktopNetworkReloadResult> {
    if (this.state().effectiveMode !== 'system' || this.runtime === undefined) {
      throw new DesktopNetworkOperationError('NOT_IN_SYSTEM_MODE', 'System proxy is not active.')
    }
    this.reloadingSystem = true
    try {
      const previousEpochId = this.state().epoch?.id
      const snapshot = await this.runtime.reloadSystem()
      this.beginEpoch('user-reload', snapshot)
      const epoch = this.state().epoch
      if (epoch === undefined) throw new Error('desktop network: reload did not create an epoch')
      return { ...(previousEpochId === undefined ? {} : { previousEpochId }), epoch,
        system: (await this.diagnostics()).system }
    } finally { this.reloadingSystem = false }
  }

  /** Record that the user will retry the same route; no business request is replayed. */
  retryLastFailure(incidentId: string): 'started' | 'no-failure' | 'stale-incident' {
    return this.incidents.retry(incidentId)
  }

  /** Retry the last visible incident without replaying its business request. */
  retryLastVisibleFailure(): DesktopNetworkRetryResult {
    const incidentId = this.state().lastIncident?.id
    return incidentId === undefined ? { status: 'no-failure' }
      : { status: this.retryLastFailure(incidentId), incidentId }
  }

  /** @returns whether the credential prompt still belongs to the active epoch. */
  isPendingChallenge(challengeId: string): boolean {
    return this.pendingChallenge?.id === challengeId && this.epochs.state() !== undefined
  }

  /** Apply a native failure-dialog choice only while its incident is current. */
  async handleFailureAction(incidentId: string, action: 'retry' | 'default-once' | 'default-always' | 'open-settings' | 'dismiss'): Promise<void> {
    const incident = this.incidents.last()
    if (incident?.id !== incidentId || incident.epochId !== this.epochs.state()?.id) return
    switch (action) {
      case 'retry':
        if (incident.failure.code === 'NETWORK_RUNTIME_EXITED') await this.options.relaunch()
        else this.incidents.retry(incidentId)
        return
      case 'default-once':
        await writeDefaultStartupOverride(this.options.userDataPath)
        await this.options.relaunch()
        return
      case 'default-always':
        await this.restoreDefaultAndRestart()
        return
      case 'open-settings':
      case 'dismiss':
        return
    }
  }

  /** Supply Manual Basic credentials after a real 407. Password never enters state or events. */
  async submitManualCredential(input: { action: 'cancel' } | { action: 'use-once' | 'save-securely'; username: string; password: string }): Promise<void> {
    if (input.action === 'cancel') return
    const state = this.state()
    const manual = this.options.preferences.load().preferences.network.manual
    if (state.effectiveMode !== 'manual' || manual === undefined || manual.protocol === 'socks5' || this.runtime === undefined) {
      throw new Error('desktop network: Manual HTTP proxy is not active')
    }
    if (input.action === 'save-securely') {
      await this.options.secrets.put(MANUAL_PROXY_PASSWORD_REF, input.password)
      await this.options.preferences.updateNetwork({
        manual: { ...manual, username: input.username, credentialRef: MANUAL_PROXY_PASSWORD_REF },
      })
    }
    await this.runtime.configure({
      mode: 'manual', strictFallback: true,
      proxy: { protocol: manual.protocol, host: manual.host, port: manual.port, username: input.username, password: input.password },
    })
    this.beginEpoch('manual-config-applied')
    if (input.action === 'save-securely') {
      const saved = { ...manual, username: input.username, credentialRef: MANUAL_PROXY_PASSWORD_REF }
      this.setCurrent({ ...this.state(), ...sanitizedManualFields(saved, true) })
    }
  }

  /** Apply one credential response only to the still-current challenge and route. */
  async submitCredential(challengeId: string, input: ProxyCredentialSubmission): Promise<void> {
    const challenge = this.pendingChallenge
    if (challenge === undefined || challenge.id !== challengeId || this.epochs.state() === undefined) return
    this.pendingChallenge = undefined
    if (input.action === 'cancel') {
      this.credentialPrompted = false
      this.reportFailure(classifyNetworkFailure({ code: challenge.rejected ? 'PROXY_AUTH_REJECTED' : 'PROXY_AUTH_REQUIRED' }), {
        kind: challenge.proxy.kind, host: challenge.proxy.host, port: challenge.proxy.port,
      })
      return
    }
    try {
      if (challenge.mode === 'manual') {
        await this.submitManualCredential(input)
        return
      }
      if (input.action === 'save-securely' || this.runtime === undefined) throw new Error('desktop network: System credentials are session-only')
      await this.runtime.submitCredential({
        protocol: challenge.proxy.kind, host: challenge.proxy.host, port: challenge.proxy.port,
        username: input.username, password: input.password,
      })
      this.credentialPrompted = false
    } catch (error) {
      if (error instanceof DesktopNetworkOperationError && (error.code === 'SECURE_STORAGE_UNAVAILABLE' || error.code === 'SECURE_STORAGE_PLAINTEXT_BACKEND')) {
        const retry = { ...challenge, id: randomUUID(), canPersist: false }
        this.pendingChallenge = retry
        this.options.onCredentialRequired?.(retry)
        return
      }
      this.credentialPrompted = false
      throw error
    }
  }

  /**
   * Validate and persist Network settings, then relaunch only after every write succeeds.
   * @param input - Renderer submission containing at most one new password value.
   * @returns never when the relaunch dependency obeys its lifecycle contract.
   */
  async saveAndRestart(input: DesktopNetworkConfigInput, options: { discardUnavailablePassword?: boolean } = {}): Promise<void> {
    const previous = this.options.preferences.load().preferences.network
    const normalized = normalizeNetworkConfigInput(input, previous.manual, previous.tests)
    const manual = await this.applyPasswordChange(
      normalized.manual, normalized.passwordChange, previous.manual, options.discardUnavailablePassword === true,
    )
    const network: DesktopNetworkPreferencesV1 = {
      mode: normalized.mode,
      ...(manual === undefined ? {} : { manual }),
      proxyAgentTraffic: normalized.proxyAgentTraffic,
      tests: normalized.tests,
    }
    await this.options.preferences.update({ network })
    await this.options.relaunch()
  }

  /** Persist Default while retaining the Manual draft and encrypted credential. */
  async restoreDefaultAndRestart(): Promise<void> {
    await this.options.preferences.updateNetwork({ mode: 'default', proxyAgentTraffic: false })
    await this.options.relaunch()
  }

  /** Delete the retained Manual password while preserving its endpoint and username. */
  async removeManualPassword(): Promise<void> {
    const manual = this.options.preferences.load().preferences.network.manual
    if (manual === undefined || manual.protocol === 'socks5' || manual.credentialRef === undefined) return
    await this.options.secrets.delete(manual.credentialRef)
    const next = { protocol: manual.protocol, host: manual.host, port: manual.port,
      ...(manual.username === undefined ? {} : { username: manual.username }) } as PersistedAuthenticatedProxy
    await this.options.preferences.updateNetwork({ manual: next })
    this.setCurrent({ ...this.state(), ...sanitizedManualFields(next, this.state().configuredMode === 'manual') })
  }

  /** Set the ephemeral Gateway returned by a later runtime implementation. */
  setGateway(gateway: DesktopGatewayEndpoint | undefined): void {
    this.gateway = gateway
  }

  /** @returns the isolated updater endpoint, which does not emit global failure incidents. */
  gatewayForUpdater(): DesktopGatewayEndpoint | undefined { return this.updaterGateway }

  /** @param base - Ambient Harness environment. @returns effective routed environment. */
  environmentForHarness(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return environmentForHarnessLaunch(base, this.environmentPolicy())
  }

  /** @param base - Ambient Desktop-owned child environment. @returns effective routed environment. */
  environmentForOwnedChild(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return environmentForOwnedChild(base, this.environmentPolicy())
  }

  /** @param base - Existing Agent child environment. @returns effective opt-in routed environment. */
  environmentForAgent(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return environmentForAgent(base, this.environmentPolicy())
  }

  /** @param ambient - Electron's original environment. @returns Host-only Agent policy. */
  agentProxyPolicyForHost(ambient: NodeJS.ProcessEnv): string | undefined {
    return agentProxyPolicyForHost(ambient, this.environmentPolicy())
  }

  private environmentPolicy(): NetworkEnvironmentPolicy {
    const state = this.state()
    return {
      mode: state.effectiveMode,
      proxyAgentTraffic: state.proxyAgentTraffic,
      ...(this.gateway === undefined ? {} : { gateway: this.gateway }),
    }
  }

  private beginEpoch(reason: 'startup' | 'manual-config-applied' | 'user-reload' | 'system-policy-changed' | 'network-changed', snapshot?: RuntimeSystemSnapshot): void {
    const epoch = this.epochs.begin(reason, snapshot?.policyFingerprint, snapshot?.networkFingerprint)
    this.incidents.beginEpoch()
    this.lastRoute = undefined
    this.pendingChallenge = undefined
    this.credentialPrompted = false
    const lastIncident = this.incidents.last()
    this.setCurrent({ ...this.state(), epoch, ...(lastIncident === undefined ? {} : { lastIncident }) })
    this.options.onEpochChanged?.()
  }

  private receiveRuntimeEvent(event: NetworkRuntimeObservation): void {
    if (this.current === undefined || this.current.effectiveMode === 'default' || this.current.effectiveMode === 'direct') return
    if (event.event === 'runtime-exited') {
      const failure = classifyNetworkFailure({ code: 'NETWORK_RUNTIME_EXITED' })
      this.pendingChallenge = undefined
      this.credentialPrompted = false
      this.setCurrent({ ...this.current, runtime: { ...this.current.runtime, status: 'failed', lastError: failure } })
      this.reportFailure(failure, this.lastRoute)
      return
    }
    if (event.event === 'system_policy_changed' || event.event === 'network_changed') {
      if (this.reloadingSystem) return
      const snapshot = systemSnapshot(event.payload)
      if (snapshot === undefined) return
      const reason = event.event === 'network_changed' ? 'network-changed' : 'system-policy-changed'
      const next = this.epochs.observe(reason, snapshot.policyFingerprint, snapshot.networkFingerprint)
      if (next !== undefined) {
        this.incidents.beginEpoch()
        this.lastRoute = undefined
        this.pendingChallenge = undefined
        this.credentialPrompted = false
        const lastIncident = this.incidents.last()
        this.setCurrent({ ...this.current, epoch: next, ...(lastIncident === undefined ? {} : { lastIncident }) })
        this.options.onEpochChanged?.()
      }
      return
    }
    if (event.event === 'route_selected' && isRecord(event.payload)) {
      this.lastRoute = route(event.payload.route)
      return
    }
    if (event.event === 'route_succeeded') {
      const succeededRoute = isRecord(event.payload) ? route(event.payload.route) : undefined
      if (this.pendingChallenge !== undefined && succeededRoute?.kind === this.pendingChallenge.proxy.kind
        && succeededRoute.host === this.pendingChallenge.proxy.host && succeededRoute.port === this.pendingChallenge.proxy.port) {
        this.pendingChallenge = undefined
        this.credentialPrompted = false
      }
      const resolved = this.incidents.resolve(this.epochs.state()?.id ?? '', succeededRoute)
      if (resolved !== undefined) this.setCurrent({ ...this.current, lastIncident: resolved })
      return
    }
    if (event.event === 'credential_required' || event.event === 'credential_rejected') {
      const selectedRoute = isRecord(event.payload) ? route(event.payload.route) : undefined
      if (selectedRoute !== undefined && (selectedRoute.kind === 'http' || selectedRoute.kind === 'https')
        && selectedRoute.host !== undefined && selectedRoute.port !== undefined && !this.credentialPrompted) {
        this.credentialPrompted = true
        const challenge: ProxyCredentialChallenge = {
          id: randomUUID(), mode: this.current.effectiveMode,
          proxy: { kind: selectedRoute.kind, host: selectedRoute.host, port: selectedRoute.port },
          scheme: 'Basic', rejected: event.event === 'credential_rejected',
          canPersist: this.current.effectiveMode === 'manual' && this.current.secureStorage.persistent,
        }
        this.pendingChallenge = challenge
        this.options.onCredentialRequired?.(challenge)
      }
      return
    }
    if (event.event === 'proxy_failure' && isRecord(event.payload)) {
      const failure = classifyNetworkFailure(event.payload.failure)
      if (failure.code === 'PROXY_AUTH_REQUIRED' || failure.code === 'PROXY_AUTH_REJECTED') return
      this.reportFailure(failure, route(event.payload.route))
    }
  }

  private reportFailure(failure: ReturnType<typeof classifyNetworkFailure>, selectedRoute?: DesktopNetworkIncidentSummary['route']): void {
    const state = this.state()
    const epoch = this.epochs.state()
    if (epoch === undefined || (state.effectiveMode !== 'manual' && state.effectiveMode !== 'system')) return
    const recorded = this.incidents.report({
      epochId: epoch.id, mode: state.effectiveMode,
      ...(selectedRoute === undefined ? {} : { route: selectedRoute }),
      failure,
    })
    if (recorded === undefined) return
    this.setCurrent({ ...state, lastIncident: recorded.incident })
    if (recorded.showDialog) this.options.onIncident?.(recorded.incident)
  }

  private async applyPasswordChange(
    manual: PersistedManualProxy | undefined,
    change: PasswordChange | undefined,
    previous: PersistedManualProxy | undefined,
    discardUnavailablePassword: boolean,
  ): Promise<PersistedManualProxy | undefined> {
    if (manual === undefined || manual.protocol === 'socks5') return manual
    const previousRef = previous !== undefined && previous.protocol !== 'socks5'
      ? previous.credentialRef
      : undefined
    if (change === undefined || change.action === 'keep') {
      const sameEndpoint = previous !== undefined && previous.protocol === manual.protocol
        && previous.host === manual.host && previous.port === manual.port
        && previous.username === manual.username
      return withCredentialRef(manual, sameEndpoint ? previousRef : undefined)
    }
    if (change.action === 'remove') {
      await this.options.secrets.delete(MANUAL_PROXY_PASSWORD_REF)
      return manual
    }
    try { await this.options.secrets.put(MANUAL_PROXY_PASSWORD_REF, change.value) }
    catch (error) {
      if (discardUnavailablePassword && error instanceof DesktopNetworkOperationError
        && (error.code === 'SECURE_STORAGE_UNAVAILABLE' || error.code === 'SECURE_STORAGE_PLAINTEXT_BACKEND')) return manual
      throw error
    }
    return withCredentialRef(manual, MANUAL_PROXY_PASSWORD_REF)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function route(value: unknown): DesktopNetworkIncidentSummary['route'] {
  if (!isRecord(value) || !['direct', 'http', 'https', 'socks5'].includes(String(value.kind))) return undefined
  if (value.kind === 'direct') return { kind: 'direct' }
  if (typeof value.host !== 'string' || value.host.length > 253 || !/^[a-zA-Z0-9.:-]+$/u.test(value.host)
    || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65_535) return undefined
  const source = typeof value.source === 'string' && ['manual', 'system-manual', 'pac', 'wpad', 'system-bypass', 'system-direct'].includes(value.source)
    ? value.source as NonNullable<DesktopNetworkIncidentSummary['route']>['source'] : undefined
  return { kind: value.kind as 'http' | 'https' | 'socks5', host: value.host, port: Number(value.port), ...(source === undefined ? {} : { source }) }
}

function systemSnapshot(value: unknown): Pick<RuntimeSystemSnapshot, 'policyFingerprint' | 'networkFingerprint'> | undefined {
  if (!isRecord(value) || typeof value.policyFingerprint !== 'string' || typeof value.networkFingerprint !== 'string') return undefined
  return { policyFingerprint: value.policyFingerprint, networkFingerprint: value.networkFingerprint }
}

function sanitizedManualFields(manual: PersistedManualProxy | undefined, active: boolean): {
  manual?: SanitizedManualProxy
  lastManual?: SanitizedManualProxy
} {
  if (manual === undefined) return {}
  const sanitized: SanitizedManualProxy = manual.protocol === 'socks5'
    ? manual
    : {
      protocol: manual.protocol,
      host: manual.host,
      port: manual.port,
      ...(manual.username === undefined ? {} : { username: manual.username }),
      hasPassword: manual.credentialRef !== undefined,
    }
  return { ...(active ? { manual: sanitized } : {}), lastManual: sanitized }
}

function withCredentialRef(
  manual: PersistedAuthenticatedProxy,
  credentialRef: PersistedAuthenticatedProxy['credentialRef'],
): PersistedAuthenticatedProxy {
  return { ...manual, ...(credentialRef === undefined ? {} : { credentialRef }) }
}
