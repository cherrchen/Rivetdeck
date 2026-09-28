/** Version and package name on a Desktop Official detail title. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { OFFICIAL_ROOT_ITEMS } from './roster.ts'
import css from './DesktopPluginBadge.module.css'

/** Props the renderer binds for one Plugins detail badge. */
export type DesktopPluginBadgeProps =
  PropsRuntime<'plugins.detail.badge'>
  & PropsLocale<'plugins.desktopRequired'>

/**
 * Show the version, Desktop tag, and package name beside the Capabilities title.
 * Other subjects render nothing.
 * @param props - Detail subject and locale copy.
 * @returns the title-row tags, or null.
 */
export function DesktopPluginBadge(props: DesktopPluginBadgeProps) {
  const { subject, t } = props
  if (subject.kind !== 'item') return null
  const item = OFFICIAL_ROOT_ITEMS.find(entry => entry.id === subject.id)
  if (item === undefined) return null
  return (
    <>
      <Tag className={css.versionTag} tone="neutral">{t('versionTag', { version: item.version })}</Tag>
      {item.id === 'desktop-capabilities'
        ? <Tag className={css.badge} tone="info">{t('desktopBadge')}</Tag>
        : null}
      <code className={css.packageName}>{item.packageName}</code>
    </>
  )
}
