/**
 * Register each Desktop-required package on the Plugins page as a read-only official item.
 * The roster is not a live inventory of running plugins.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DesktopPluginCard } from './DesktopPluginCard.tsx'
import { en, zh, type DesktopPluginsLocaleKey } from './locales.ts'
import { REQUIRED_DESKTOP_PLUGINS } from './roster.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop-required plugin roster copy. */
    'plugins.desktopRequired': DesktopPluginsLocaleKey
  }
}

/** Dictionary namespace owned by the Desktop plugin roster. */
export const NS = 'plugins.desktopRequired'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * List each required overlay package on the Plugins page.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-desktop-plugins: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('plugins.item', function* () {
    for (const plugin of REQUIRED_DESKTOP_PLUGINS) {
      yield ctx.slots.register({
        name: 'plugins.item',
        id: plugin.id,
        order: plugin.order,
        label: () => t(plugin.labelKey),
        locale: NS,
      }, DesktopPluginCard)
    }
  })
}
