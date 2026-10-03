// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopNetworkState } from '../src/network/domain.ts'
import type { DesktopCapabilitiesContract } from '../runtime/plugins/desktop-capabilities/src/client/index.ts'
import { parseNetworkTestRequest, runNetworkTests } from '../src/network/test-service.ts'
import { draftErrors, draftFromState } from '../runtime/plugins/desktop-capabilities/src/client/features/network-settings/form.ts'
import type { RuntimeSnapshot } from '../src/toolchains/domain.ts'
import { en as runtimeEn } from '../runtime/plugins/desktop-capabilities/src/client/features/runtime-settings/locales.ts'
import { NetworkSettingsSection, type NetworkSettingsInjected } from '../runtime/plugins/desktop-capabilities/src/client/features/network-settings/NetworkSettingsSection.tsx'
import { en } from '../runtime/plugins/desktop-capabilities/src/client/features/network-settings/locales.ts'
import { apply as networkApply, inject as networkInject } from '../runtime/plugins/desktop-capabilities/src/client/features/network-settings/index.ts'
import { openNetworkSettings } from '../runtime/plugins/desktop-capabilities/src/client/features/network-settings/navigation.ts'

const base: DesktopNetworkState = {
  configuredMode: 'manual', effectiveMode: 'manual',
  manual: { protocol: 'http', host: 'proxy.example', port: 8080, username: 'alice', hasPassword: true },
  lastManual: { protocol: 'http', host: 'proxy.example', port: 8080, username: 'alice', hasPassword: true },
  proxyAgentTraffic: false, restartRequired: false,
  runtime: { status: 'ready', gateway: { host: '127.0.0.1', port: 43125 } },
  secureStorage: { available: true, persistent: true, backend: 'keychain' },
  testSettings: { internet204Url: 'https://example.com/204', githubUrl: 'https://github.com/' },
}

const translate: TranslateNS<'settings.networkElectron'> = key => en[key as keyof typeof en]

function view(state: DesktopNetworkState = base, runtimeSettings?: NetworkSettingsInjected['runtimeSettings']) {
  const saveAndRestart = vi.fn<DesktopCapabilitiesContract['network']['saveAndRestart']>().mockResolvedValue(undefined)
  const network: DesktopCapabilitiesContract['network'] = {
    getState: vi.fn<DesktopCapabilitiesContract['network']['getState']>().mockResolvedValue(state),
    subscribe: () => () => undefined,
    saveAndRestart,
    restoreDefaultAndRestart: vi.fn<DesktopCapabilitiesContract['network']['restoreDefaultAndRestart']>().mockResolvedValue(undefined),
    reloadSystemProxy: vi.fn<DesktopCapabilitiesContract['network']['reloadSystemProxy']>().mockResolvedValue({ epoch: { id: '', startedAt: '', reason: 'user-reload' } }),
    getDiagnostics: vi.fn<DesktopCapabilitiesContract['network']['getDiagnostics']>().mockResolvedValue({ mode: state.effectiveMode, runtime: { status: 'ready' } }),
    test: vi.fn<DesktopCapabilitiesContract['network']['test']>().mockResolvedValue({ startedAt: '', finishedAt: '', results: [
      { kind: 'proxy', status: 'unreachable', error: { code: 'PROXY_CONNECT_REFUSED', message: 'Failed', retryable: true } },
      { kind: 'internet', status: 'unreachable' }, { kind: 'github', status: 'unreachable' }, { kind: 'llm', status: 'not-configured' },
    ] }),
    retryLastFailure: vi.fn<DesktopCapabilitiesContract['network']['retryLastFailure']>().mockResolvedValue({ status: 'no-failure' }),
    removeManualPassword: vi.fn<DesktopCapabilitiesContract['network']['removeManualPassword']>().mockResolvedValue(undefined),
  }
  render(createElement(NetworkSettingsSection, { network, shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
    runtimeSettings, providers: async () => [], t: translate, close: () => undefined }))
  return { network, saveAndRestart }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Network settings UI', () => {
  it('shows network and independent runtime actions under one settings heading', async () => {
    const snapshot: RuntimeSnapshot = {
      onboardingCompleted: true,
      node: { name: 'node', version: '24.17.0', phase: 'not-installed', restartRequired: false },
      python: { name: 'python', version: '3.14.7', phase: 'not-installed', restartRequired: false },
    }
    view(base, {
      t: key => runtimeEn[key as keyof typeof runtimeEn], restart: async () => {},
      runtimes: {
        getState: async () => snapshot,
        subscribe: (listener) => { listener(snapshot); return () => {} },
        install: async () => {}, cancel: async () => {}, remove: async () => {}, completeOnboarding: async () => {},
      },
    })
    await screen.findByRole('heading', { name: en.nav })
    expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toMatchInlineSnapshot(`
      [
        "Network & Runtimes",
      ]
    `)
    expect(screen.getByRole('heading', { name: runtimeEn.title })).toBeTruthy()
    expect(await screen.findAllByRole('button', { name: runtimeEn.install })).toHaveLength(2)
    expect(screen.getByRole('button', { name: en.save })).toBeTruthy()
  })

  it('navigates from the failure dialog request to the Network section', async () => {
    const root = document.createElement('div')
    const trigger = document.createElement('button')
    trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.setAttribute('aria-label', 'Settings')
    root.append(trigger)
    document.body.append(root)
    const select = vi.fn()
    trigger.addEventListener('click', () => {
      queueMicrotask(() => {
        const panel = document.createElement('div')
        panel.setAttribute('role', 'dialog')
        const nav = document.createElement('nav')
        const button = document.createElement('button')
        button.textContent = 'Network'
        button.addEventListener('click', select)
        nav.append(button)
        panel.append(nav)
        root.append(panel)
      })
    })
    const cancel = openNetworkSettings('Settings', 'Network')
    try { await vi.waitFor(() => { expect(select).toHaveBeenCalledOnce() }) }
    finally { cancel(); root.remove() }
  })

  it('registers one section and releases its state listener with the plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const subscribe = vi.fn(() => () => undefined)
    ctx.provide('desktop', { network: { subscribe } } as never)
    new TestRemote(ctx, { llm: { listProviders: vi.fn() } })
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    const fiber = await ctx.plugin({ inject: [...networkInject], apply: networkApply }).await()
    expect(slots.entries('settings.section')[0]?.options).toMatchObject({ id: 'network', order: 60 })
    expect(subscribe).toHaveBeenCalledOnce()
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
  })

  it('keeps a stored password out of the input and omits credentials for SOCKS5', async () => {
    view()
    const password = await screen.findByLabelText('Password (optional)') as HTMLInputElement
    expect(password.value).toBe('')
    expect(password.placeholder).toBe('••••••••')
    fireEvent.click(screen.getByText('SOCKS5'))
    expect(screen.queryByLabelText('Password (optional)')).toBeNull()
    expect(screen.queryByLabelText('Username (optional)')).toBeNull()
  })

  it('does not gate Save on failed connection tests', async () => {
    const network = view()
    await screen.findByText('Manual Proxy')
    expect(screen.queryByText('Tests the currently active mode for diagnostics only; failure never blocks saving.')).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'other.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findAllByText('Unreachable')
    const save = screen.getByRole('button', { name: 'Save & Restart' })
    expect(save).not.toHaveProperty('disabled', true)
    fireEvent.click(save)
    await vi.waitFor(() => { expect(network.saveAndRestart).toHaveBeenCalledOnce() })
    expect(network.saveAndRestart.mock.calls[0]?.[0]).toMatchObject({ mode: 'manual', manual: { host: 'other.example' } })
  })

  it('asks before discarding a new password when secure storage is unavailable', async () => {
    const network = view({ ...base, secureStorage: { available: false, persistent: false, backend: 'basic_text', warning: 'plaintext-backend' } })
    await screen.findByLabelText('Password (optional)')
    fireEvent.change(screen.getByLabelText('Password (optional)'), { target: { value: 'new-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Restart' }))
    expect(await screen.findByText('Secure credential storage is unavailable')).toBeTruthy()
    expect(network.saveAndRestart).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save & Restart Anyway' }))
    await vi.waitFor(() => { expect(network.saveAndRestart).toHaveBeenCalledOnce() })
    expect(network.saveAndRestart.mock.calls[0]?.[1]).toBe(true)
  })
})

describe('Network diagnostic and draft contracts', () => {
  it('never returns a stored password and rejects invalid form fields', () => {
    const draft = draftFromState(base)
    expect(JSON.stringify(draft)).not.toContain('secret')
    expect(draftErrors({ ...draft, host: 'https://proxy.example', port: '0' })).toEqual(expect.objectContaining({ host: true, port: true }))
  })

  it('uses one endpoint per test and treats any HTTP response as transport reachable', async () => {
    const fetchOne = vi.fn().mockResolvedValueOnce({ status: 204 }).mockResolvedValueOnce({ status: 401 })
    const result = await runNetworkTests({ tests: ['internet', 'llm'], overrides: { llm: { providerId: 'deepseek', healthUrl: 'https://api.example.com/health' } } },
      base.testSettings, fetchOne)
    expect(result.results.map(item => [item.status, item.httpStatus])).toEqual([['reachable', 204], ['reachable', 401]])
    expect(fetchOne).toHaveBeenCalledTimes(2)
    const request = {
      tests: ['internet', 'github', 'llm'] as const,
      overrides: { internet204Url: 'https://example.com/204', githubUrl: 'https://github.com',
        llm: { providerId: 'test', healthUrl: 'https://example.com/health' } },
    }
    expect(parseNetworkTestRequest(request)).toEqual(request)
    expect(() => parseNetworkTestRequest({ tests: [1] })).toThrow()
    expect(() => parseNetworkTestRequest({ tests: ['internet', 'internet'] })).toThrow()
    expect(() => parseNetworkTestRequest({ tests: ['internet'], overrides: { unexpected: 'x' } })).toThrow()
  })

  it('reports a Gateway failure separately from an origin HTTP error', async () => {
    const fetchOne = vi.fn().mockResolvedValueOnce({ status: 502, networkErrorCode: 'PROXY_CONNECT_REFUSED' })
      .mockResolvedValueOnce({ status: 502 })
    const result = await runNetworkTests({ tests: ['internet', 'github'] }, base.testSettings, fetchOne)
    expect(result.results[0]).toMatchObject({ status: 'unreachable', httpStatus: 502,
      stage: 'proxy-connect', error: { code: 'PROXY_CONNECT_REFUSED' } })
    expect(result.results[1]).toMatchObject({ status: 'reachable', httpStatus: 502 })
  })

  it('reads the selected System route after each destination resolves', async () => {
    const routeForTest = vi.fn().mockResolvedValueOnce({ kind: 'http', host: 'first.proxy', port: 8080 })
      .mockResolvedValueOnce({ kind: 'direct', source: 'system-direct' })
    const result = await runNetworkTests({ tests: ['internet', 'github'] }, base.testSettings,
      vi.fn().mockResolvedValue({ status: 204 }), routeForTest)
    expect(result.results.map(item => item.route?.kind)).toEqual(['http', 'direct'])
    expect(routeForTest).toHaveBeenCalledTimes(2)
  })
})
