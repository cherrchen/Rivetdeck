/** Read-only Components roster on the Desktop Capabilities detail page. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { PluginArtworkDefault, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CAPABILITIES_COMPONENTS } from './roster.ts'
import css from './CapabilitiesComponents.module.css'

/** The size plugin artwork renders at inside a row's 40px frame. */
const ROW_ARTWORK_SIZE = 30

/** Props the renderer binds for one Plugins detail section. */
export type CapabilitiesComponentsProps =
  PropsRuntime<'plugins.detail.section'>
  & PropsLocale<'plugins.desktopRequired'>

/**
 * List Desktop product components on the Capabilities item page; otherwise render nothing.
 * The heading, count, and rows match a bundle's contained-components block.
 * Rows stay read-only and are not live Loader inventory.
 * @param props - Detail subject and locale copy.
 * @returns the Components section, or null.
 */
export function CapabilitiesComponentsSection(props: CapabilitiesComponentsProps) {
  const { subject, t } = props
  if (subject.kind !== 'item' || subject.id !== 'desktop-capabilities') return null
  const count = String(CAPABILITIES_COMPONENTS.length)
  const summary = [t('countTotal', { count }), t('countOff', { count })].join(' · ')
  return (
    <section className={css.section} aria-label={t('components')} data-plugin-rows>
      <div className={css.sectionHead}>
        <h4 className={css.title}>{t('components')}</h4>
        <span className={css.count}>{summary}</span>
      </div>
      <ul className={css.list}>
        {CAPABILITIES_COMPONENTS.map((component) => {
          const title = t(component.labelKey)
          return (
            <li key={component.id} className={css.row} data-plugin-row={component.id} data-state="off">
              <div className={css.rowLine}>
                <span className={css.rowIcon} aria-hidden="true">
                  <PluginArtworkDefault size={ROW_ARTWORK_SIZE} />
                </span>
                <div className={css.rowMain}>
                  <span className={css.rowId}>{title}</span>
                  <code className={css.rowModule}>{component.id}</code>
                  {component.moduleName === undefined
                    ? null
                    : <code className={css.rowModule}>{component.moduleName}</code>}
                </div>
                <span className={css.rowState}>
                  <StateDot state="idle" />
                  {t('partOff')}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
