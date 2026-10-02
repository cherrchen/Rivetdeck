/** Desktop-owned runtime section and optional first-profile dialog use the shared shell slots. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RuntimeSettings, RuntimeSetup } from './RuntimeSettings.tsx'
import { en, zh, type RuntimeLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.runtimesElectron': RuntimeLocaleKey }
}
/** Required services supplied by the Desktop Client composition. */
export const inject = ['slots', 'locale', 'desktop']
/** Register dictionaries and views using the existing Settings and overlay slots.
 * @param ctx Client context with approved Desktop capabilities.
 */
export function apply(ctx: Context): void {
  const locale = 'settings.runtimesElectron' as const
  ctx.effect(() => ctx.locale.register(locale, { en, zh }), 'runtime-settings: dictionaries')
  const t = ctx.locale.bind(locale)
  const injected = () => ({ runtimes: ctx.desktop.runtimes, restart: () => ctx.desktop.app.relaunch() })
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'runtimes', order: 70, label: () => t('title'), locale, inject: injected }, RuntimeSettings))
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding', id: 'runtime-setup', order: -200, locale, inject: injected,
  }, RuntimeSetup))
}
