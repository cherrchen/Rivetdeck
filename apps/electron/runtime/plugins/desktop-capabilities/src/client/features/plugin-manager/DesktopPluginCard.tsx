/** Official Plugins page card for a Desktop-owned item: roster copy, not live inventory. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Props the renderer binds for one Desktop-owned plugin card. */
export type DesktopPluginCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'plugins.desktopRequired'>

/**
 * Render the one-liner or the required-by-Desktop notice.
 * @param props - View requested by the Plugins page and locale copy.
 * @returns Built-in summary or required-page copy.
 */
export function DesktopPluginCard(props: DesktopPluginCardProps) {
  const { t } = props
  if (props.view === 'summary') return t('builtIn')
  return t('required')
}
