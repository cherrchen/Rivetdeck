// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { NetworkSettingsSection } from '../runtime/plugins/desktop-capabilities/src/client/features/network-settings/NetworkSettingsSection.tsx'
import type { NetworkSettingsInjected } from '../runtime/plugins/desktop-capabilities/src/client/features/network-settings/NetworkSettingsSection.tsx'
import { zh } from '../runtime/plugins/desktop-capabilities/src/client/features/network-settings/locales.ts'
import type { DesktopNetworkState } from '../src/network/domain.ts'

afterEach(cleanup)

async function setup() {
  const state: DesktopNetworkState = {
    configuredMode: 'default', effectiveMode: 'default', proxyAgentTraffic: false, restartRequired: false,
    runtime: { status: 'inactive' }, secureStorage: { available: true, persistent: true },
    testSettings: { internet204Url: 'https://example.test/204', githubUrl: 'https://github.com' },
  }
  const network = {
    getState: vi.fn(async () => state), subscribe: () => () => {},
    getDiagnostics: vi.fn(async () => ({ mode: 'default' as const, runtime: { status: 'inactive' as const } })),
    test: vi.fn(async (_request: Parameters<NetworkSettingsInjected['network']['test']>[0]) => ({ startedAt: '', finishedAt: '', results: [{ kind: 'internet' as const, status: 'reachable' as const, httpStatus: 204 }] })),
    saveAndRestart: vi.fn(async (_input: Parameters<NetworkSettingsInjected['network']['saveAndRestart']>[0], _discard?: boolean) => {}), restoreDefaultAndRestart: vi.fn(async () => {}),
    reloadSystemProxy: vi.fn(), retryLastFailure: vi.fn(), removeManualPassword: vi.fn(async () => {}),
  } satisfies NetworkSettingsInjected['network']
  render(<NetworkSettingsSection network={network}
    shell={{ openExternal: async () => {}, openPath: async () => {}, showItemInFolder: async () => {} }}
    providers={async () => [{ id: 'provider-1', name: 'Test Provider' }]} t={key => zh[key as keyof typeof zh]} />)
  await screen.findByRole('button', { name: zh.advanced })
  return network
}

async function openDiagnostics() {
  fireEvent.click(screen.getByRole('button', { name: zh.advanced }))
  return screen.findByRole('dialog', { name: zh.advanced })
}

describe('network settings diagnostics dialog', () => {
  it('moves tests into two tabs and restores focus when Escape closes the dialog', async () => {
    const network = await setup()
    expect(screen.queryByRole('button', { name: zh.testConnection })).toBeNull()
    const save = screen.getByRole('button', { name: zh.save })
    expect(save.parentElement).toBe(screen.getByRole('button', { name: zh.restore }).parentElement)
    const trigger = screen.getByRole('button', { name: zh.advanced })
    trigger.focus()
    const dialog = await openDiagnostics()
    expect([...within(dialog).getAllByRole('tab')].map(tab => tab.textContent)).toMatchInlineSnapshot(`
      [
        "连接测试与诊断",
        "测试端点",
      ]
    `)
    expect(within(dialog).getByRole('tabpanel').textContent).toContain(zh.activeMode)
    fireEvent.click(within(dialog).getByRole('button', { name: zh.testConnection }))
    await waitFor(() => { expect(within(dialog).getByRole('tabpanel').textContent).toContain('HTTP 204') })
    expect(network.test).toHaveBeenCalledWith({ tests: ['proxy', 'internet', 'github', 'llm'], overrides: {
      internet204Url: 'https://example.test/204', githubUrl: 'https://github.com', llm: {},
    } })
    const firstTab = within(dialog).getByRole('tab', { name: zh.testsAndDiagnostics })
    fireEvent.keyDown(firstTab, { key: 'ArrowRight' })
    expect(within(dialog).getByRole('tab', { name: zh.testEndpoints }).getAttribute('aria-selected')).toBe('true')
    expect(within(dialog).queryByRole('button', { name: zh.testConnection })).toBeNull()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(document.activeElement).toBe(trigger)
  })

  it('discards endpoint edits, validates Keep, and saves only retained edits with the outer form', async () => {
    const network = await setup()
    let dialog = await openDiagnostics()
    fireEvent.click(within(dialog).getByRole('tab', { name: zh.testEndpoints }))
    let internet = within(dialog).getByLabelText(zh.internetUrl)
    fireEvent.change(internet, { target: { value: 'invalid' } })
    expect(within(dialog).getByRole('button', { name: zh.keepEndpoints }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: zh.discardEndpoints }))
    expect((internet as HTMLInputElement).value).toBe('https://example.test/204')
    fireEvent.change(internet, { target: { value: 'https://discarded.test/204' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.close }))
    expect(screen.getByRole('button', { name: zh.save }).hasAttribute('disabled')).toBe(true)
    dialog = await openDiagnostics()
    fireEvent.click(within(dialog).getByRole('tab', { name: zh.testEndpoints }))
    internet = within(dialog).getByLabelText(zh.internetUrl)
    expect((internet as HTMLInputElement).value).toBe('https://example.test/204')
    fireEvent.change(internet, { target: { value: 'https://retained.test/204' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.keepEndpoints }))
    expect(network.saveAndRestart).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('tab', { name: zh.testsAndDiagnostics }))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.testConnection })) })
    expect(network.test.mock.calls.at(-1)?.[0].overrides?.internet204Url).toBe('https://retained.test/204')
    fireEvent.click(within(dialog).getByRole('button', { name: zh.close }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.save })) })
    expect(network.saveAndRestart.mock.calls[0]?.[0].tests?.internet204Url).toBe('https://retained.test/204')
    expect(network.saveAndRestart.mock.calls[0]?.[1]).toBe(false)
  })
})
