/**
 * Fill workspace directory-flow slots with Electron Main's directory chooser.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ElectronDirectoryFlow, type ElectronFlowInjected } from './flow.ts'

/** Cordis plugin name used by fiber diagnostics. */
export const name = 'directory-picker'

/** Slot registration plus the desktop directory chooser. */
export const inject = ['slots', 'desktop']

/**
 * @param ctx - Feature fiber that has `slots` and `desktop`.
 */
export function apply(ctx: ClientContext): void {
  const injected = (): ElectronFlowInjected => ({
    pick: async () => {
      const result = await ctx.desktop.dialog.pickDirectory()
      return result?.path ?? null
    },
  })
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({
        name: 'conversation.hero.workspace.directoryFlow', inject: injected,
      }, ElectronDirectoryFlow)
      yield ctx.slots.register({
        name: 'sidebar.workspaces.directoryFlow', inject: injected,
      }, ElectronDirectoryFlow)
    }))
}
