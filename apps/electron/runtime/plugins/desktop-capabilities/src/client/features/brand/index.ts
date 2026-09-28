/**
 * Fill shipped brand slots so Desktop never shows the upstream local-build fallback.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { DesktopBrandMark, DesktopBrandName } from './Brand.tsx'

/** Cordis plugin name used by fiber diagnostics. */
export const name = 'brand'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill every shipped brand slot as one declaration-aware registration set.
 * @param ctx - Feature fiber that has `slots`.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, DesktopBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, DesktopBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, DesktopBrandMark)
      })))
}
