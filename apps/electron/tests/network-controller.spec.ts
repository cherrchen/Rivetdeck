import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DesktopPreferencesStore } from '../src/preferences.ts'
import { DesktopNetworkController } from '../src/network/controller.ts'
import type { DesktopSecretStore } from '../src/network/secret-store.ts'
import { MANUAL_PROXY_PASSWORD_REF } from '../src/network/domain.ts'

describe('Desktop Network controller foundation', () => {
  it('broadcasts a dialog navigation request to independent subscribers without changing mode', async () => {
    const fixture = await createFixture()
    try {
      await fixture.controller.prepare()
      const first = vi.fn()
      const second = vi.fn()
      const unsubscribeFirst = fixture.controller.subscribe(first)
      const unsubscribeSecond = fixture.controller.subscribe(second)
      fixture.controller.requestOpenSettings()
      expect(first).toHaveBeenCalledTimes(2)
      expect(second).toHaveBeenCalledTimes(2)
      expect(fixture.controller.state()).toMatchObject({ configuredMode: 'default', effectiveMode: 'default' })
      expect(typeof fixture.controller.state().openSettingsRequestId).toBe('string')
      unsubscribeFirst()
      fixture.controller.requestOpenSettings()
      expect(first).toHaveBeenCalledTimes(2)
      expect(second).toHaveBeenCalledTimes(3)
      unsubscribeSecond()
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  })

  it('configures the sole Manual endpoint before publishing the Gateway to Harness children', async () => {
    const fixture = await createFixture()
    try {
      await fixture.preferences.updateNetwork({
        mode: 'manual',
        manual: { protocol: 'https', host: 'proxy.example', port: 443, username: 'alice', credentialRef: MANUAL_PROXY_PASSWORD_REF },
      })
      fixture.secrets.get = vi.fn().mockResolvedValue('secret-value')
      await fixture.controller.prepare()
      expect(() => fixture.controller.environmentForHarness({})).toThrow(/ready Gateway/)
      const runtime = {
        start: vi.fn().mockResolvedValue({
          protocolVersion: 2, gateway: { host: '127.0.0.1', port: 4123 }, updaterGateway: { host: '127.0.0.1', port: 4124 },
          systemBackend: 'unsupported', capabilities: { manual: { http: true, https: true, socks5: true, socks5Auth: false }, system: { manual: false, pac: false, wpad: false, watchers: false }, auth: { basic: true, digest: false, ntlm: false, negotiate: false } },
        }),
        configure: vi.fn().mockResolvedValue(undefined),
        onEvent: vi.fn(() => () => undefined),
        diagnostics: vi.fn().mockResolvedValue({ configured: true }),
        getSystemSnapshot: vi.fn().mockRejectedValue(new Error('System is inactive')),
        reloadSystem: vi.fn().mockRejectedValue(new Error('System is inactive')),
        submitCredential: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } satisfies Parameters<DesktopNetworkController['startRuntime']>[0]
      await fixture.controller.startRuntime(runtime)
      expect(runtime.configure).toHaveBeenCalledWith({
        mode: 'manual', strictFallback: true,
        proxy: { protocol: 'https', host: 'proxy.example', port: 443, username: 'alice', password: 'secret-value' },
      })
      expect(fixture.controller.environmentForHarness({ HTTP_PROXY: 'ambient' }).HTTP_PROXY).toBe('http://127.0.0.1:4123')
      expect(JSON.stringify(fixture.controller.state())).not.toContain('secret-value')
      await fixture.controller.shutdown()
      expect(runtime.shutdown).toHaveBeenCalledOnce()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
  it('prepares Default without activating a runtime', async () => {
    const fixture = await createFixture()
    await fixture.controller.prepare()
    expect(fixture.controller.state()).toMatchObject({
      configuredMode: 'default',
      effectiveMode: 'default',
      runtime: { status: 'inactive' },
    })
  })

  it('persists Manual state and a secret reference without serializing the password', async () => {
    const fixture = await createFixture()
    await fixture.controller.prepare()
    await expect(fixture.controller.saveAndRestart({
      mode: 'manual',
      manual: {
        protocol: 'https',
        host: 'proxy.example',
        port: 443,
        username: 'alice',
        passwordChange: { action: 'replace', value: 'secret-value' },
      },
      proxyAgentTraffic: true,
    })).rejects.toThrow('relaunched')
    const disk = await readFile(join(fixture.root, 'desktop-preferences.json'), 'utf8')
    expect(disk).not.toContain('secret-value')
    expect(disk).toContain('network.manual.proxy.password.v1')
    expect(fixture.secrets.put).toHaveBeenCalledWith('network.manual.proxy.password.v1', 'secret-value')
  })

  it('restores Default without deleting the retained Manual draft', async () => {
    const fixture = await createFixture()
    await fixture.preferences.updateNetwork({
      mode: 'manual',
      manual: { protocol: 'http', host: 'localhost', port: 7890 },
    })
    await fixture.controller.prepare()
    await expect(fixture.controller.restoreDefaultAndRestart()).rejects.toThrow('relaunched')
    expect(fixture.preferences.load().preferences.network).toMatchObject({
      mode: 'default', manual: { protocol: 'http', host: 'localhost', port: 7890 },
    })
  })
})

async function createFixture(): Promise<{
  root: string
  preferences: DesktopPreferencesStore
  secrets: DesktopSecretStore & { put: ReturnType<typeof vi.fn> }
  controller: DesktopNetworkController
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-electron-controller-'))
  const preferences = new DesktopPreferencesStore(root)
  const secrets = {
    status: vi.fn().mockResolvedValue({ available: true, persistent: true, backend: 'keychain' }),
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  }
  return {
    root,
    preferences,
    secrets,
    controller: new DesktopNetworkController({
      userDataPath: root,
      preferences,
      secrets,
      relaunch: async () => { throw new Error('relaunched') },
    }),
  }
}
