/** Electron-owned Network settings page registered into the shared Settings shell. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { NetworkSettingsSection, type NetworkSettingsInjected } from './NetworkSettingsSection.tsx'
import { en, zh, type NetworkLocaleKey } from './locales.ts'
import { openNetworkSettings } from './navigation.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop Network settings and diagnostics copy. */
    'settings.networkElectron': NetworkLocaleKey
  }
}

/** Dictionary namespace owned by the Desktop Network page. */
export const NS = 'settings.networkElectron'

/** Cordis plugin name used by fiber diagnostics. */
export const name = 'network-settings'

/** Services required by the Network settings page. */
export const inject = ['slots', 'locale', 'desktop', 'remote', 'remote.llm']

/** Register the combined Network and Runtime settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'network-settings: dictionaries')
  const t = ctx.locale.bind(NS)
  const settingsT = ctx.locale.bind('settings')
  const injected = (): NetworkSettingsInjected => ({
    runtimeSettings: { runtimes: ctx.desktop.runtimes, restart: () => ctx.desktop.app.relaunch(), t: ctx.locale.bind('settings.runtimesElectron') },
    network: ctx.desktop.network,
    shell: ctx.desktop.shell,
    providers: async () => {
      const response = await ctx.remote.llm.listProviders()
      return response.ok ? response.value.map(provider => ({ id: provider.id, name: provider.name })) : []
    },
  })
  let lastOpenRequestId: string | undefined
  ctx.effect(() => {
    let cancelNavigation: (() => void) | undefined
    const unsubscribe = ctx.desktop.network.subscribe((state) => {
      if (state.openSettingsRequestId === undefined || state.openSettingsRequestId === lastOpenRequestId) return
      lastOpenRequestId = state.openSettingsRequestId
      cancelNavigation?.()
      cancelNavigation = openNetworkSettings(settingsT('trigger'), t('nav'))
    })
    return () => { unsubscribe(); cancelNavigation?.() }
  }, 'network-settings: failure dialog navigation')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'network', order: 60,
    label: () => t('nav'), locale: NS, inject: injected,
  }, NetworkSettingsSection))
}
