/** Read-only Components roster on the Desktop Capabilities detail page. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { PluginArtworkDefault, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { CAPABILITIES_COMPONENTS } from './roster.ts'
import { partsSummary, rowDataState, rowDotState, rowStateKey, type ComponentRuntimeMap } from './runtime.ts'
import css from './CapabilitiesComponents.module.css'

/** The size plugin artwork renders at inside a row's 40px frame. */
const ROW_ARTWORK_SIZE = 30

/** Slot inject: live Host inventory and Client fiber phases for the roster. */
export interface CapabilitiesComponentsInjected {
  hooks: { runtimes: ObservableSnapshot<ComponentRuntimeMap | null> }
}

/** Props the renderer binds for one Plugins detail section. */
export type CapabilitiesComponentsProps =
  PropsRuntime<'plugins.detail.section'>
  & PropsLocale<'plugins.desktopRequired'>
  & InjectFace<CapabilitiesComponentsInjected>

/**
 * List Desktop product components on the Capabilities item page; otherwise render nothing.
 * The heading, count, and rows match a bundle's contained-components block.
 * Each row shows its product id and package specifier. Rows stay read-only.
 * Displayed phase comes from `useRuntimes`, not from a hardcoded Off.
 * @param props - Detail subject, locale copy, and live runtimes selector.
 * @returns the Components section, or null.
 */
export function CapabilitiesComponentsSection(props: CapabilitiesComponentsProps) {
  const { subject, t, useRuntimes } = props
  if (subject.kind !== 'item' || subject.id !== 'desktop-capabilities') return null
  const runtimes = useRuntimes(map => map)
  const unread = runtimes === null
  const summary = partsSummary(
    CAPABILITIES_COMPONENTS.length,
    unread ? [] : CAPABILITIES_COMPONENTS.map(component => runtimes[component.id]),
    t,
  )
  return (
    <section className={css.section} aria-label={t('components')} data-plugin-rows>
      <div className={css.sectionHead}>
        <h4 className={css.title}>{t('components')}</h4>
        <span className={css.count}>{summary}</span>
      </div>
      <ul className={css.list}>
        {CAPABILITIES_COMPONENTS.map((component) => {
          const title = t(component.labelKey)
          const runtime = runtimes?.[component.id]
          const dataState = rowDataState(runtime)
          return (
            <li
              key={component.id}
              className={css.row}
              data-plugin-row={component.id}
              {...dataState === undefined ? {} : { 'data-state': dataState }}
            >
              <div className={css.rowLine}>
                <span className={css.rowIcon} aria-hidden="true">
                  <PluginArtworkDefault size={ROW_ARTWORK_SIZE} />
                </span>
                <div className={css.rowMain}>
                  <span className={css.rowId}>{title}</span>
                  <code className={css.rowModule}>{component.id}</code>
                  <code className={css.rowModule}>{component.moduleName}</code>
                </div>
                {unread
                  ? null
                  : (
                    <span className={css.rowState}>
                      <StateDot state={rowDotState(runtime)} />
                      {t(rowStateKey(runtime))}
                    </span>
                  )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
