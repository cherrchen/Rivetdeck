/** Register the Electron runtime's shared-profile watches on the Host HMR queue. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../../../src/desktop-runtime.ts'

/** Required Host services owned by upstream composition; Electron services are read on demand. */
export const inject = ['hmr', 'loader']

/** Start runtime watches for this adapter's lifetime.
 * The Desktop runtime is launcher-owned, so it is read from the service store instead of
 * declared as an injection: a declared edge from an Include child to a root provision keeps the
 * root fiber waiting for this tree during shutdown and deadlocks profile teardown.
 * @param ctx Host context with the launcher-owned runtime.
 */
export async function apply(ctx: Context): Promise<void> {
  const runtime = ctx.get('desktopRuntime')
  if (runtime === undefined) throw new Error('desktop-capabilities requires the Desktop runtime service')
  await runtime.watch(ctx)
}
