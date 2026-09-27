/**
 * Register Desktop Capabilities and Theme Studio as Official items, plus the
 * Capabilities Components section. The roster is not a live inventory.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CapabilitiesComponentsSection } from './CapabilitiesComponents.tsx'
import { DesktopPluginCard } from './DesktopPluginCard.tsx'
import { en, zh, type DesktopPluginsLocaleKey } from './locales.ts'
import { OFFICIAL_ROOT_ITEMS } from './roster.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop Official roster and Capabilities component copy. */
    'plugins.desktopRequired': DesktopPluginsLocaleKey
  }
}

/** Dictionary namespace owned by the Desktop plugin roster. */
export const NS = 'plugins.desktopRequired'

/** Cordis plugin name used by fiber diagnostics. */
export const name = 'plugin-manager'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * List the two Electron-owned Official items and the Capabilities Components section.
 * @param ctx - Feature fiber that has `slots` and `locale`.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-manager: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('plugins.item', function* () {
    for (const item of OFFICIAL_ROOT_ITEMS) {
      yield ctx.slots.register({
        name: 'plugins.item',
        id: item.id,
        order: item.order,
        label: () => t(item.labelKey),
        locale: NS,
      }, DesktopPluginCard)
    }
  })
  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
    name: 'plugins.detail.section',
    id: 'desktop-capabilities-components',
    order: 100,
    locale: NS,
  }, CapabilitiesComponentsSection))
}
