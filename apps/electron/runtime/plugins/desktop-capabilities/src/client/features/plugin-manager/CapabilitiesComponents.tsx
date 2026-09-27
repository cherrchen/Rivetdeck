/** Read-only Components roster on the Desktop Capabilities detail page. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CAPABILITIES_COMPONENTS } from './roster.ts'
import css from './CapabilitiesComponents.module.css'

/** Props the renderer binds for one Plugins detail section. */
export type CapabilitiesComponentsProps =
  PropsRuntime<'plugins.detail.section'>
  & PropsLocale<'plugins.desktopRequired'>

/**
 * List Desktop product components on the Capabilities item page; otherwise render nothing.
 * @param props - Detail subject and locale copy.
 * @returns the Components section, or null.
 */
export function CapabilitiesComponentsSection(props: CapabilitiesComponentsProps) {
  const { subject, t } = props
  if (subject.kind !== 'item' || subject.id !== 'desktop-capabilities') return null
  return (
    <section className={css.section} aria-label={t('components')}>
      <h4 className={css.title}>{t('components')}</h4>
      <ul className={css.list}>
        {CAPABILITIES_COMPONENTS.map(component => (
          <li key={component.id} className={css.row}>{t(component.labelKey)}</li>
        ))}
      </ul>
    </section>
  )
}
