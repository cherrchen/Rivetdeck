/** Register the Electron runtime's shared-profile watches on the Host HMR queue. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../../../src/desktop-runtime.ts'

/** Required Host services for runtime reconciliation. */
export const inject = ['hmr', 'desktopRuntime', 'appReady', 'pluginPackages', 'loader']

/** Start runtime watches for this adapter's lifetime.
 * @param ctx Host context with the launcher-owned runtime.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.desktopRuntime.watch(ctx)
}
