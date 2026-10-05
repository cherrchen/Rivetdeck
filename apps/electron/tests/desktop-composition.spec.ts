// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../runtime/plugins/desktop-capabilities/src/client/index.ts'
import { DesktopCapabilitiesService } from '../runtime/plugins/desktop-capabilities/src/client/service.ts'
import * as directoryPicker from '../runtime/plugins/desktop-capabilities/src/client/features/directory-picker/index.ts'
import * as brand from '../runtime/plugins/desktop-capabilities/src/client/features/brand/index.ts'
import * as networkSettings from '../runtime/plugins/desktop-capabilities/src/client/features/network-settings/index.ts'
import * as pluginManager from '../runtime/plugins/desktop-capabilities/src/client/features/plugin-manager/index.ts'

const HOLES = {
  'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' },
  'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
  'sidebar.brand.mark': { kind: 'single', scope: 'root' },
  'sidebar.brand.name': { kind: 'single', scope: 'root' },
  'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
  'settings.section': { kind: 'list', scope: 'root' },
  'settings.onboarding': { kind: 'list', scope: 'root' },
  'plugins.item': { kind: 'list', scope: 'root' },
  'plugins.detail.badge': { kind: 'list', scope: 'root' },
  'plugins.detail.section': { kind: 'list', scope: 'root' },
} as const

afterEach(() => {
  vi.restoreAllMocks()
})

function installBridge() {
  const unsubscribe = vi.fn()
  Object.assign(globalThis.window, {
    deepseekDesktop: {
      app: { getVersion: async () => '1', getPlatform: async () => 'darwin', relaunch: async () => undefined },
      dialog: { pickDirectory: async () => null },
      clipboard: { readText: async () => '', writeText: async () => undefined },
      shell: { openExternal: async () => undefined, openPath: async () => undefined, showItemInFolder: async () => undefined },
      notification: { show: async () => ({ shown: true }) },
      updater: {
        check: async () => undefined, download: async () => undefined, install: async () => undefined,
        getState: async () => ({ state: 'idle' as const }), subscribe: () => () => undefined,
      },
      theme: {
        getState: async () => ({ shouldUseDarkColors: false, themeSource: 'system' as const }),
        subscribe: () => () => undefined,
      },
      window: {
        minimize: async () => undefined, maximize: async () => undefined, close: async () => undefined,
        getState: async () => ({ isMaximized: false, isFullScreen: false }),
      },
      network: {
        getState: async () => ({ configuredMode: 'default' as const }),
        saveAndRestart: async () => undefined,
        restoreDefaultAndRestart: async () => undefined,
        reloadSystemProxy: async () => ({}),
        test: async () => ({ startedAt: '', finishedAt: '', results: [] }),
        getDiagnostics: async () => ({ mode: 'default' as const, runtime: { status: 'inactive' as const } }),
        retryLastFailure: async () => ({ status: 'no-failure' as const }),
        removeManualPassword: async () => undefined,
        subscribe: () => unsubscribe,
      },
    },
  })
  return unsubscribe
}

async function assemble() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  new TestRemote(ctx, {
    llm: { listProviders: vi.fn() },
    pluginInventory: { list: vi.fn(async () => ({ ok: true as const, value: { entries: [] } })) },
  })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: HOLES } as never, () => null)
  return { ctx, slots }
}

describe('desktop capabilities client composition', () => {
  it('registers directory-flow, brand, network settings, and plugin-manager slots', async () => {
    installBridge()
    const { ctx, slots } = await assemble()
    const fiber = await ctx.plugin({ apply }).await()
    expect(slots.entries('conversation.hero.workspace.directoryFlow')).toHaveLength(1)
    expect(slots.entries('sidebar.workspaces.directoryFlow')).toHaveLength(1)
    expect(slots.entries('sidebar.brand.mark')).toHaveLength(1)
    expect(slots.entries('sidebar.brand.name')).toHaveLength(1)
    expect(slots.entries('conversation.hero.brand.mark')).toHaveLength(1)
    expect(slots.entries('settings.section').map(entry => entry.options.id)).toEqual(['network'])
    expect(slots.entries('settings.section')[0]?.options).toMatchObject({ id: 'network', order: 60 })
    expect(slots.entries('settings.onboarding').map(entry => entry.options.id)).toEqual(['runtime-setup'])
    expect(slots.entries('plugins.item').map(entry => entry.options.id)).toEqual([
      'desktop-capabilities',
    ])
    expect(slots.entries('plugins.detail.badge')[0]?.options.id).toBe('desktop-capabilities-badge')
    expect(slots.entries('plugins.detail.section')[0]?.options.id).toBe('desktop-capabilities-components')
    await fiber.dispose()
    expect(slots.entries('conversation.hero.workspace.directoryFlow')).toHaveLength(0)
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(slots.entries('plugins.detail.badge')).toHaveLength(0)
    expect(slots.entries('plugins.detail.section')).toHaveLength(0)
    expect(slots.entries('sidebar.brand.mark')).toHaveLength(0)
  })

  it('keeps desktop-injecting features pending until ctx.desktop is provided', async () => {
    installBridge()
    const { ctx, slots } = await assemble()
    const picker = ctx.plugin(directoryPicker)
    const settings = ctx.plugin(networkSettings)
    ctx.plugin(brand)
    ctx.plugin(pluginManager)
    await Promise.resolve()
    expect(ctx.get('desktop')).toBeUndefined()
    expect(slots.entries('conversation.hero.workspace.directoryFlow')).toHaveLength(0)
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('sidebar.brand.mark')).toHaveLength(1)
    expect(slots.entries('plugins.item')).toHaveLength(1)
    await ctx.plugin(DesktopCapabilitiesService).await()
    await picker.await()
    await settings.await()
    expect(ctx.get('desktop')).toBeDefined()
    expect(slots.entries('conversation.hero.workspace.directoryFlow')).toHaveLength(1)
    expect(slots.entries('settings.section')[0]?.options.id).toBe('network')
  })
})
