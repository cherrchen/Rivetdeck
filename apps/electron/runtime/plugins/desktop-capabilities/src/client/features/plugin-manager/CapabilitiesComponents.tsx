/** Read-only Components roster on the Desktop Capabilities detail page. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { PluginArtworkDefault, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { componentsForItem, usesPackageTitle, type RosterComponent } from './roster.ts'
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
 * Title of one roster row.
 * Theme Studio uses the npm package name. Capabilities uses the localized product name.
 * @param component - roster row.
 * @param t - locale translate.
 * @returns the row title.
 */
function rowTitle(
  component: RosterComponent,
  t: CapabilitiesComponentsProps['t'],
): string {
  return usesPackageTitle(component) ? component.moduleName : t(component.labelKey)
}

/**
 * List product components on a Desktop Official item page; otherwise render nothing.
 * The heading, count, and rows match a bundle's contained-components block.
 * Capabilities rows show a product name, a sentence, the short id, and the package specifier.
 * Theme Studio shows one package row: the npm name, a sentence, and the patch id.
 * Rows stay read-only. Displayed phase comes from `useRuntimes`, not from a hardcoded Off.
 * @param props - Detail subject, locale copy, and live runtimes selector.
 * @returns the Components section, or null.
 */
export function CapabilitiesComponentsSection(props: CapabilitiesComponentsProps) {
  const { subject, t, useRuntimes } = props
  if (subject.kind !== 'item') return null
  const components = componentsForItem(subject.id)
  if (components === undefined) return null
  const runtimes = useRuntimes(map => map)
  const unread = runtimes === null
  const summary = partsSummary(
    components.length,
    unread ? [] : components.map(component => runtimes[component.id]),
    t,
  )
  return (
    <section className={css.section} aria-label={t('components')} data-plugin-rows>
      <div className={css.sectionHead}>
        <h4 className={css.title}>{t('components')}</h4>
        <span className={css.count}>{summary}</span>
      </div>
      <ul className={css.list}>
        {components.map((component) => {
          const title = rowTitle(component, t)
          const packaged = usesPackageTitle(component)
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
                  <span className={css.rowDesc}>{t(component.descriptionKey)}</span>
                  {title === component.id ? null : <code className={css.rowModule}>{component.id}</code>}
                  {packaged || title === component.moduleName
                    ? null
                    : <code className={css.rowModule}>{component.moduleName}</code>}
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
