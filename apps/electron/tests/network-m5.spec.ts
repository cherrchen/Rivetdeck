import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopPreferencesStore } from '../src/preferences.ts'
import { DesktopNetworkController } from '../src/network/controller.ts'
import { parseCredentialSubmission, credentialDocument } from '../src/network/credential-window.ts'
import { NetworkEpochManager } from '../src/network/epoch.ts'
import { classifyNetworkFailure } from '../src/network/failure.ts'
import { presentNetworkFailure } from '../src/network/failure-dialog.ts'
import { NetworkIncidentManager } from '../src/network/incidents.ts'
import { resolveDesktopMainLocale } from '../src/locale.ts'
import type { NetworkRuntimeObservation } from '../src/network/runtime-client.ts'
import type { DesktopSecretStore } from '../src/network/secret-store.ts'
import { DesktopNetworkOperationError } from '../src/network/errors.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('M5 policy generations and incidents', () => {
  it('uses fingerprints for live changes and never creates an epoch for a request failure', () => {
    let sequence = 0
    const epochs = new NetworkEpochManager(() => new Date('2026-09-23T00:00:00Z'), () => String(++sequence))
    const first = epochs.begin('startup', 'policy-a', 'network-a')
    expect(epochs.observe('system-policy-changed', 'policy-a', 'network-a')).toBeUndefined()
    expect(epochs.state()).toEqual(first)
    const changed = epochs.observe('system-policy-changed', 'policy-b', 'network-a')
    expect(changed).toMatchObject({ id: '2', reason: 'system-policy-changed', policyFingerprint: 'policy-b' })
    expect(epochs.observe('network-changed', 'policy-b', 'network-b')).toMatchObject({ id: '3', reason: 'network-changed' })
  })

  it('classifies only proxy and policy failures as incidents and deduplicates 20 concurrent refusals', () => {
    const incidents = new NetworkIncidentManager(() => new Date('2026-09-23T00:00:00Z'), () => 'incident-1')
    const route = { kind: 'http' as const, host: '127.0.0.1', port: 7890 }
    const failure = classifyNetworkFailure({ code: 'PROXY_CONNECT_REFUSED', message: 'password=sensitive' })
    expect(failure).toMatchObject({ code: 'PROXY_CONNECT_REFUSED', stage: 'proxy-connect', proxyFailure: true })
    expect(JSON.stringify(failure)).not.toContain('sensitive')
    expect(classifyNetworkFailure({ code: 'TARGET_CONNECT_FAILED' }).proxyFailure).toBe(false)
    expect(classifyNetworkFailure({ code: 'OFFLINE' }).proxyFailure).toBe(false)
    const results = Array.from({ length: 20 }, () => incidents.report({ epochId: 'one', mode: 'system', route, failure }))
    expect(results.filter(result => result?.showDialog)).toHaveLength(1)
    expect(incidents.retry('incident-1')).toBe('started')
    expect(incidents.report({ epochId: 'one', mode: 'system', route, failure })?.showDialog).toBe(true)
    incidents.beginEpoch()
    expect(incidents.report({ epochId: 'two', mode: 'system', route, failure })?.showDialog).toBe(true)
  })

  it('keeps native action choices separate from the stored proxy configuration', async () => {
    const responses = [1, 1]
    const dialog = { showMessageBox: vi.fn(async () => ({ response: responses.shift() ?? 3 })) }
    const incident = {
      id: 'incident-1', createdAt: '2026-09-23T00:00:00Z', epochId: 'epoch-1', mode: 'manual' as const,
      route: { kind: 'http' as const, host: 'proxy.example', port: 8080 },
      failure: classifyNetworkFailure({ code: 'PROXY_CONNECT_REFUSED' }), dialogShown: true,
    }
    const result = await presentNetworkFailure({ incident, messages: resolveDesktopMainLocale('en').messages, dialog })
    expect(result).toBe('default-always')
    expect(JSON.stringify(dialog.showMessageBox.mock.calls)).not.toContain('TOP_SECRET')
  })
})

describe('M5 controller recovery', () => {
  it('creates one incident from real traffic, creates a new epoch on policy change, and keeps stale proxy failures from opening a second dialog', async () => {
    const fixture = await controllerFixture('system')
    const runtime = runtimeFixture()
    await fixture.controller.prepare()
    await fixture.controller.startRuntime(runtime.client)
    const firstEpoch = fixture.controller.state().epoch?.id
    const route = { kind: 'http', host: '127.0.0.1', port: 7890 }
    for (let i = 0; i < 20; i++) runtime.emit({ event: 'proxy_failure', payload: { route, failure: { code: 'PROXY_CONNECT_REFUSED' } } })
    expect(fixture.incidents).toHaveLength(1)
    expect(fixture.controller.state().epoch?.id).toBe(firstEpoch)
    runtime.emit({ event: 'system_policy_changed', payload: snapshot('policy-b', 'network-a') })
    expect(fixture.controller.state().epoch?.id).not.toBe(firstEpoch)
    runtime.emit({ event: 'proxy_failure', payload: { route, failure: { code: 'PROXY_CONNECT_REFUSED' } } })
    expect(fixture.incidents).toHaveLength(2)
    runtime.emit({ event: 'route_succeeded', payload: { route } })
    expect(fixture.controller.state().lastIncident?.resolvedAt).toBeDefined()
  })

  it('accepts a one-shot Default without changing the persisted Manual proxy and consumes it once', async () => {
    const fixture = await controllerFixture('manual')
    const runtime = runtimeFixture()
    await fixture.controller.prepare()
    await fixture.controller.startRuntime(runtime.client)
    const incident = fixture.controller.state().lastIncident
    expect(incident).toBeUndefined()
    // A real connection refusal is the only source of this action.
    runtime.emit({ event: 'proxy_failure', payload: { route: { kind: 'http', host: '127.0.0.1', port: 7890 }, failure: { code: 'PROXY_CONNECT_REFUSED' } } })
    const recorded = fixture.controller.state().lastIncident!
    await fixture.controller.handleFailureAction(recorded.id, 'default-once')
    expect(fixture.relaunch).toHaveBeenCalledOnce()
    expect(fixture.preferences.load().preferences.network.mode).toBe('manual')
    const options = {
      userDataPath: fixture.root, preferences: fixture.preferences,
      secrets: fixture.secrets, relaunch: fixture.relaunch,
    }
    const next = new DesktopNetworkController(options)
    await next.prepare()
    expect(next.state()).toMatchObject({ configuredMode: 'manual', effectiveMode: 'default', startupOverride: 'default' })
    const later = new DesktopNetworkController(options)
    await later.prepare()
    expect(later.state().effectiveMode).toBe('manual')
  })

  it('discards a new password only after an explicit Save Anyway while secure storage is unavailable', async () => {
    const fixture = await controllerFixture('default')
    fixture.secrets.put = vi.fn().mockRejectedValue(new DesktopNetworkOperationError('SECURE_STORAGE_PLAINTEXT_BACKEND', 'Secure storage unavailable.'))
    await fixture.controller.prepare()
    const input = { mode: 'manual' as const, manual: { protocol: 'http' as const, host: '127.0.0.1', port: 7890, username: 'alice', passwordChange: { action: 'replace' as const, value: 'TOP_SECRET' } } }
    await expect(fixture.controller.saveAndRestart(input)).rejects.toMatchObject({ code: 'SECURE_STORAGE_PLAINTEXT_BACKEND' })
    expect(fixture.relaunch).not.toHaveBeenCalled()
    await fixture.controller.saveAndRestart(input, { discardUnavailablePassword: true })
    const disk = await readFile(join(fixture.root, 'desktop-preferences.json'), 'utf8')
    expect(disk).not.toContain('TOP_SECRET')
    expect(disk).not.toContain('credentialRef')
    expect(fixture.relaunch).toHaveBeenCalledOnce()
  })

  it('offers Manual 407 once, supports use-once, and creates an incident when the user cancels', async () => {
    const fixture = await controllerFixture('manual')
    const runtime = runtimeFixture()
    await fixture.controller.prepare()
    await fixture.controller.startRuntime(runtime.client)
    const route = { kind: 'http', host: '127.0.0.1', port: 7890 }
    for (let i = 0; i < 20; i++) runtime.emit({ event: 'credential_required', payload: { route } })
    expect(fixture.challenges).toHaveLength(1)
    await fixture.controller.submitCredential(fixture.challenges[0]!.id, { action: 'use-once', username: 'user', password: 'TOP_SECRET' })
    expect(runtime.calls.configure).toHaveBeenLastCalledWith({
      mode: 'manual', strictFallback: true,
      proxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: 'user', password: 'TOP_SECRET' },
    })
    expect(fixture.controller.state().epoch?.reason).toBe('manual-config-applied')
    expect(fixture.secrets.put).not.toHaveBeenCalled()
    expect(JSON.stringify(fixture.controller.state())).not.toContain('TOP_SECRET')
    runtime.emit({ event: 'credential_rejected', payload: { route } })
    expect(fixture.challenges).toHaveLength(2)
    await fixture.controller.submitCredential(fixture.challenges[1]!.id, { action: 'cancel' })
    expect(fixture.incidents).toHaveLength(1)
    expect(fixture.controller.state().lastIncident?.failure.code).toBe('PROXY_AUTH_REJECTED')
    runtime.emit({ event: 'credential_required', payload: { route } })
    expect(fixture.challenges).toHaveLength(3)
    expect(fixture.controller.isPendingChallenge(fixture.challenges[2]!.id)).toBe(true)
  })

  it('keeps System Basic credentials in runtime memory and never persists them', async () => {
    const fixture = await controllerFixture('system')
    const runtime = runtimeFixture()
    await fixture.controller.prepare()
    await fixture.controller.startRuntime(runtime.client)
    const route = { kind: 'https', host: 'proxy.example', port: 443 }
    runtime.emit({ event: 'credential_required', payload: { route } })
    expect(fixture.challenges[0]).toMatchObject({ mode: 'system', canPersist: false })
    await fixture.controller.submitCredential(fixture.challenges[0]!.id, { action: 'use-once', username: 'alice', password: 'TOP_SECRET' })
    expect(runtime.calls.submitCredential).toHaveBeenCalledWith({ protocol: 'https', host: 'proxy.example', port: 443, username: 'alice', password: 'TOP_SECRET' })
    expect(fixture.secrets.put).not.toHaveBeenCalled()
    expect(await readFile(join(fixture.root, 'desktop-preferences.json'), 'utf8')).not.toContain('TOP_SECRET')
  })

  it('reports a runtime crash and retries by relaunching without selecting Direct', async () => {
    const fixture = await controllerFixture('manual')
    const runtime = runtimeFixture()
    await fixture.controller.prepare()
    await fixture.controller.startRuntime(runtime.client)
    runtime.emit({ event: 'credential_required', payload: { route: { kind: 'http', host: '127.0.0.1', port: 7890 } } })
    expect(fixture.controller.isPendingChallenge(fixture.challenges[0]!.id)).toBe(true)
    runtime.emit({ event: 'runtime-exited', payload: { code: 'NETWORK_RUNTIME_EXITED' } })
    expect(fixture.controller.isPendingChallenge(fixture.challenges[0]!.id)).toBe(false)
    expect(fixture.controller.state()).toMatchObject({ effectiveMode: 'manual', runtime: { status: 'failed' }, lastIncident: { failure: { code: 'NETWORK_RUNTIME_EXITED' } } })
    await fixture.controller.handleFailureAction(fixture.controller.state().lastIncident!.id, 'retry')
    expect(fixture.relaunch).toHaveBeenCalledOnce()
    expect(fixture.preferences.load().preferences.network.mode).toBe('manual')
  })

  it('creates exactly one user-reload epoch when Runtime emits its policy event before responding', async () => {
    const fixture = await controllerFixture('system')
    const runtime = runtimeFixture()
    await fixture.controller.prepare()
    await fixture.controller.startRuntime(runtime.client)
    runtime.calls.reloadSystem.mockImplementation(async () => {
      runtime.emit({ event: 'system_policy_changed', payload: snapshot('policy-b', 'network-a') })
      return snapshot('policy-b', 'network-a')
    })
    await fixture.controller.reloadSystemProxy()
    expect(fixture.controller.state().epoch).toMatchObject({ reason: 'user-reload', policyFingerprint: 'policy-b' })
    expect(fixture.epochChanges).toBe(2)
  })

  it('follows graceful Mihomo policy restoration but waits for real traffic after a force kill', async () => {
    const fixture = await controllerFixture('system')
    const runtime = runtimeFixture()
    await fixture.controller.prepare()
    await fixture.controller.startRuntime(runtime.client)
    const originalEpoch = fixture.controller.state().epoch?.id
    expect(fixture.controller.state().epoch?.id).toBe(originalEpoch)
    expect(fixture.incidents).toHaveLength(0)
    runtime.emit({ event: 'proxy_failure', payload: { route: { kind: 'http', host: '127.0.0.1', port: 7890 }, failure: { code: 'PROXY_CONNECT_REFUSED' } } })
    expect(fixture.incidents).toHaveLength(1)
    runtime.emit({ event: 'system_policy_changed', payload: snapshot('direct-policy', 'network-a') })
    expect(fixture.controller.state().epoch?.id).not.toBe(originalEpoch)
    expect(fixture.incidents).toHaveLength(1)
    expect(fixture.controller.state().lastIncident?.resolvedAt).toBeDefined()
  })

  it('keeps proxy credentials out of the isolated prompt document', () => {
    const challenge = { id: 'one', mode: 'system' as const, proxy: { kind: 'https' as const, host: 'proxy.example', port: 443 }, scheme: 'Basic' as const, rejected: false, canPersist: false }
    const html = decodeURIComponent(credentialDocument(challenge, resolveDesktopMainLocale('en'), 'safe-nonce'))
    expect(html).toContain('Content-Security-Policy')
    expect(html).not.toContain('Save Securely')
    expect(parseCredentialSubmission({ action: 'save-securely', username: 'x', password: 'y' }, false)).toBeUndefined()
    expect(parseCredentialSubmission({ action: 'use-once', username: 'x', password: 'y' }, false)).toEqual({ action: 'use-once', username: 'x', password: 'y' })
    expect(parseCredentialSubmission({ action: 'use-once', username: 'x\r\nInjected', password: 'y' }, true)).toBeUndefined()
  })
})

function snapshot(policyFingerprint: string, networkFingerprint: string) {
  return { backend: 'linux-gnome', policySource: 'manual', policyFingerprint, networkFingerprint, pac: { configured: false, state: 'none' }, alternativeRoutes: [] }
}

function runtimeFixture() {
  const listeners = new Set<(event: NetworkRuntimeObservation) => void>()
  const client = {
    start: vi.fn().mockResolvedValue({
      protocolVersion: 2, gateway: { host: '127.0.0.1', port: 4123 }, updaterGateway: { host: '127.0.0.1', port: 4124 },
      systemBackend: 'linux-gnome', capabilities: { manual: { http: true, https: true, socks5: true, socks5Auth: false }, system: { manual: true, pac: true, wpad: false, watchers: true }, auth: { basic: true, digest: false, ntlm: false, negotiate: false } },
    }),
    configure: vi.fn().mockResolvedValue(undefined),
    diagnostics: vi.fn().mockResolvedValue({ configured: true }),
    getSystemSnapshot: vi.fn().mockResolvedValue(snapshot('policy-a', 'network-a')),
    reloadSystem: vi.fn().mockResolvedValue(snapshot('policy-b', 'network-a')),
    submitCredential: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn((listener: (event: NetworkRuntimeObservation) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } satisfies Parameters<DesktopNetworkController['startRuntime']>[0]
  return {
    client,
    emit: (event: NetworkRuntimeObservation) => { for (const listener of listeners) listener(event) },
    calls: client,
  }
}

async function controllerFixture(mode: 'default' | 'system' | 'manual') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-electron-m5-'))
  roots.push(root)
  const preferences = new DesktopPreferencesStore(root)
  await preferences.updateNetwork(mode === 'manual' ? { mode, manual: { protocol: 'http', host: '127.0.0.1', port: 7890 } } : { mode })
  const secrets: DesktopSecretStore & { put: ReturnType<typeof vi.fn> } = {
    status: vi.fn().mockResolvedValue({ available: true, persistent: true, backend: 'keychain' }),
    put: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined),
  }
  const incidents: unknown[] = []
  const challenges: import('../src/network/domain.ts').ProxyCredentialChallenge[] = []
  let epochChanges = 0
  const relaunch = vi.fn().mockResolvedValue(undefined)
  const controller = new DesktopNetworkController({
    userDataPath: root, preferences, secrets, relaunch,
    onIncident: (value) => { incidents.push(value) },
    onCredentialRequired: (value) => { challenges.push(value) },
    onEpochChanged: () => { epochChanges++ },
  })
  return { root, preferences, secrets, incidents, challenges, relaunch, controller, get epochChanges() { return epochChanges } }
}
