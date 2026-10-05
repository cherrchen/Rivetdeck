// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { describe, expect, it } from 'vitest'
import {
  apply,
  createDesktopCapabilities,
  requireDesktopBridge,
  type DesktopCapabilitiesContract,
} from '../runtime/plugins/desktop-capabilities/src/client/index.ts'
import { DesktopCapabilitiesService } from '../runtime/plugins/desktop-capabilities/src/client/service.ts'
import {
  apply as directoryPickerApply,
  inject as directoryPickerInject,
} from '../runtime/plugins/desktop-capabilities/src/client/features/directory-picker/index.ts'

describe('desktop capability provider contract', () => {
  it('fails clearly when the preload bridge is unavailable', () => {
    delete (globalThis as { window?: { deepseekDesktop?: unknown } }).window?.deepseekDesktop
    expect(() => requireDesktopBridge()).toThrow(/window\.deepseekDesktop is unavailable/)
  })

  it('exposes only approved capability groups and forwards calls', async () => {
    const calls: string[] = []
    const bridge = {
      app: {
        getVersion: async () => { calls.push('app.getVersion'); return '1.0.0' },
        getPlatform: async () => { calls.push('app.getPlatform'); return 'darwin' },
        relaunch: async () => { calls.push('app.relaunch') },
      },
      dialog: {
        pickDirectory: async () => { calls.push('dialog.pickDirectory'); return { path: '/tmp' } },
      },
      clipboard: {
        readText: async () => { calls.push('clipboard.readText'); return 'hi' },
        writeText: async (text: string) => { calls.push(`clipboard.writeText:${text}`) },
      },
      shell: {
        openExternal: async (url: string) => { calls.push(`shell.openExternal:${url}`) },
        openPath: async (path: string) => { calls.push(`shell.openPath:${path}`) },
        showItemInFolder: async (path: string) => { calls.push(`shell.showItemInFolder:${path}`) },
      },
      notification: {
        show: async () => { calls.push('notification.show'); return { shown: true } },
      },
      updater: {
        check: async () => { calls.push('updater.check') },
        download: async () => { calls.push('updater.download') },
        install: async () => { calls.push('updater.install') },
        getState: async () => { calls.push('updater.getState'); return { state: 'idle' as const } },
        subscribe: (callback: (state: { state: 'idle' }) => void) => {
          calls.push('updater.subscribe')
          callback({ state: 'idle' })
          return () => { calls.push('updater.unsubscribe') }
        },
      },
      theme: {
        getState: async () => { calls.push('theme.getState'); return { shouldUseDarkColors: false, themeSource: 'system' as const } },
        subscribe: (callback: (state: { shouldUseDarkColors: boolean; themeSource: 'system' }) => void) => {
          calls.push('theme.subscribe')
          callback({ shouldUseDarkColors: false, themeSource: 'system' })
          return () => { calls.push('theme.unsubscribe') }
        },
      },
      window: {
        minimize: async () => { calls.push('window.minimize') },
        maximize: async () => { calls.push('window.maximize') },
        close: async () => { calls.push('window.close') },
        getState: async () => { calls.push('window.getState'); return { isMaximized: false, isFullScreen: false } },
      },
      network: {
        getState: async () => { calls.push('network.getState'); return { configuredMode: 'default' as const } },
        saveAndRestart: async () => { calls.push('network.saveAndRestart') },
        restoreDefaultAndRestart: async () => { calls.push('network.restoreDefaultAndRestart') },
        reloadSystemProxy: async () => { calls.push('network.reloadSystemProxy'); return {} },
        test: async () => { calls.push('network.test'); return { startedAt: '', finishedAt: '', results: [] } },
        getDiagnostics: async () => { calls.push('network.getDiagnostics'); return { mode: 'default' as const, runtime: { status: 'inactive' as const } } },
        retryLastFailure: async () => { calls.push('network.retryLastFailure'); return { status: 'no-failure' as const } },
        removeManualPassword: async () => { calls.push('network.removeManualPassword') },
        subscribe: () => { calls.push('network.subscribe'); return () => undefined },
      },
    }
    globalThis.window = { deepseekDesktop: bridge } as Window & typeof globalThis

    const desktop: DesktopCapabilitiesContract = createDesktopCapabilities(requireDesktopBridge())
    expect(Object.keys(desktop).sort()).toEqual([
      'app', 'clipboard', 'dialog', 'network', 'notification', 'runtimes', 'shell', 'theme', 'updater', 'window',
    ])
    expect(await desktop.dialog.pickDirectory()).toEqual({ path: '/tmp' })
    expect(await desktop.updater.getState()).toEqual({ state: 'idle' })
    await desktop.clipboard.writeText('hello')
    desktop.updater.subscribe(() => {})
    expect((await desktop.network.getState()).configuredMode).toBe('default')
    await desktop.app.relaunch()
    expect(calls).toContain('dialog.pickDirectory')
    expect(calls).toContain('clipboard.writeText:hello')
    expect(calls).toContain('updater.subscribe')
    expect(calls).toContain('app.relaunch')
    expect(JSON.stringify(desktop)).not.toContain('ipcRenderer')
    expect(JSON.stringify(desktop)).not.toContain('invoke')
  })

  it('registers ctx.desktop before the preload bridge is available', async () => {
    delete (globalThis as { window?: { deepseekDesktop?: unknown } }).window?.deepseekDesktop
    const ctx = new Context()
    const fiber = ctx.plugin(DesktopCapabilitiesService)
    await fiber.await()
    const desktop = ctx.get('desktop')
    if (desktop === undefined) throw new Error('desktop capability service was not registered')
    await expect(desktop.dialog.pickDirectory()).rejects.toThrow(/window\.deepseekDesktop is unavailable/)
    await expect(desktop.app.relaunch()).rejects.toThrow(/window\.deepseekDesktop is unavailable/)
  })

  it('provides ctx.desktop from the composition root before feature injects settle', async () => {
    const ctx = new Context()
    await ctx.plugin({ apply }).await()
    const desktop = ctx.get('desktop')
    if (desktop === undefined) throw new Error('desktop capability service was not registered')
    expect(ctx.get('slots')).toBeUndefined()
  })
})

describe('directory-picker feature', () => {
  it('registers both directory-flow slots and releases them on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('desktop', {
      dialog: { pickDirectory: async () => ({ path: '/tmp' }) },
    })
    const slots = ctx.get('slots')
    if (slots === undefined) throw new Error('slot registry was not registered')
    slots.register({
      name: 'root',
      children: {
        'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' },
        'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
      },
    } as never, () => null)
    const fiber = await ctx.plugin({
      inject: [...directoryPickerInject],
      apply: directoryPickerApply,
    }).await()
    expect(slots.entries('conversation.hero.workspace.directoryFlow')).toHaveLength(1)
    expect(slots.entries('sidebar.workspaces.directoryFlow')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('conversation.hero.workspace.directoryFlow')).toHaveLength(0)
    expect(slots.entries('sidebar.workspaces.directoryFlow')).toHaveLength(0)
  })
})
