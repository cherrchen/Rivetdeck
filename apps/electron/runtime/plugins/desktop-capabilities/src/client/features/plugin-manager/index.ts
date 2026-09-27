/**
 * Register Desktop Capabilities as an Official item, its title badges, and the
 * Capabilities component section. Rows cannot be switched; displayed phase comes
 * from Host `pluginInventory/list` and Client feature fibers.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CapabilitiesComponentsSection } from './CapabilitiesComponents.tsx'
import { DesktopPluginBadge } from './DesktopPluginBadge.tsx'
import { CapabilitiesItemCard } from './DesktopPluginCard.tsx'
import { createRuntimesSource, watchComponentRuntimes } from './inventory-source.ts'
import { en, zh, type DesktopPluginsLocaleKey } from './locales.ts'
import { OFFICIAL_ROOT_ITEMS, type OfficialRootItem } from './roster.ts'

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
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory']

/** Card component for one Official item. */
const ITEM_CARDS = {
  'desktop-capabilities': CapabilitiesItemCard,
} satisfies Record<OfficialRootItem['id'], typeof CapabilitiesItemCard>

/**
 * List the Electron-owned Desktop Capabilities Official item, its title badges,
 * and the component section. Rows cannot be switched; displayed phase comes from
 * Host `pluginInventory/list` and Client feature fibers.
 * @param ctx - Feature fiber that has `slots`, `locale`, and `remote.pluginInventory`.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-manager: dictionaries')
  const t = ctx.locale.bind(NS)
  const runtimes = createRuntimesSource()
  ctx.effect(() => watchComponentRuntimes(ctx, runtimes), 'plugin-manager: component runtimes')
  ctx.slots.inject('plugins.item', function* () {
    for (const item of OFFICIAL_ROOT_ITEMS) {
      yield ctx.slots.register({
        name: 'plugins.item',
        id: item.id,
        order: item.order,
        label: () => t(item.labelKey),
        locale: NS,
      }, ITEM_CARDS[item.id])
    }
  })
  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
    name: 'plugins.detail.badge',
    id: 'desktop-capabilities-badge',
    order: 10,
    locale: NS,
  }, DesktopPluginBadge))
  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
    name: 'plugins.detail.section',
    id: 'desktop-capabilities-components',
    order: 100,
    locale: NS,
    inject: () => ({ hooks: { runtimes } }),
  }, CapabilitiesComponentsSection))
}
