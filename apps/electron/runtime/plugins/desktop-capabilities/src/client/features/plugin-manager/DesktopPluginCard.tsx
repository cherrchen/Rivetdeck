/** Official Plugins page card: a plain-language one-liner, not a live inventory claim. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { OFFICIAL_ROOT_ITEMS, type OfficialRootItem } from './roster.ts'

/** Props the renderer binds for one Desktop-owned plugin card. */
export type DesktopPluginCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'plugins.desktopRequired'>

/**
 * Render the Official card one-liner. The detail page body is the component section.
 * @param props - View requested by the Plugins page and locale copy.
 * @param id - Official item this card belongs to.
 * @returns the description, or nothing for the page view.
 */
function summaryFor(props: DesktopPluginCardProps, id: OfficialRootItem['id']) {
  const item = OFFICIAL_ROOT_ITEMS.find(entry => entry.id === id)
  if (item === undefined || props.view !== 'summary') return null
  return props.t(item.descriptionKey)
}

/** Desktop Capabilities card. */
export function CapabilitiesItemCard(props: DesktopPluginCardProps) {
  return summaryFor(props, 'desktop-capabilities')
}

/** Theme Studio card. */
export function ThemeStudioItemCard(props: DesktopPluginCardProps) {
  return summaryFor(props, 'theme-studio')
}
