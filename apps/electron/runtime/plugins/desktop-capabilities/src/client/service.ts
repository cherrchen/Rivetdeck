/**
 * Desktop capability provider service (`ctx.desktop`).
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { DesktopCapabilitiesContract } from './contract.ts'
import { createDesktopCapabilities, requireDesktopBridge } from './contract.ts'

/**
 * Bind capability groups on first use so the Cordis service registers even
 * when the preload bridge is not yet available during web boot settlement.
 * @returns Capability groups that resolve the bridge lazily.
 */
function createLazyDesktopCapabilities(): DesktopCapabilitiesContract {
  let cached: DesktopCapabilitiesContract | undefined
  const resolve = (): DesktopCapabilitiesContract => {
    cached ??= createDesktopCapabilities(requireDesktopBridge())
    return cached
  }
  return {
    runtimes: {
      getState: async () => resolve().runtimes.getState(),
      install: async name => resolve().runtimes.install(name),
      cancel: async name => resolve().runtimes.cancel(name),
      remove: async name => resolve().runtimes.remove(name),
      completeOnboarding: async () => resolve().runtimes.completeOnboarding(),
      subscribe: callback => resolve().runtimes.subscribe(callback),
    },
    app: {
      getVersion: async () => resolve().app.getVersion(),
      getPlatform: async () => resolve().app.getPlatform(),
      relaunch: async () => resolve().app.relaunch(),
    },
    dialog: {
      pickDirectory: async options => resolve().dialog.pickDirectory(options),
    },
    clipboard: {
      readText: async () => resolve().clipboard.readText(),
      writeText: async text => resolve().clipboard.writeText(text),
    },
    shell: {
      openExternal: async url => resolve().shell.openExternal(url),
      openPath: async path => resolve().shell.openPath(path),
      showItemInFolder: async path => resolve().shell.showItemInFolder(path),
    },
    notification: {
      show: async options => resolve().notification.show(options),
    },
    updater: {
      check: async () => resolve().updater.check(),
      download: async () => resolve().updater.download(),
      install: async () => resolve().updater.install(),
      getState: async () => resolve().updater.getState(),
      subscribe: callback => resolve().updater.subscribe(callback),
    },
    theme: {
      getState: async () => resolve().theme.getState(),
      subscribe: callback => resolve().theme.subscribe(callback),
    },
    window: {
      minimize: async () => resolve().window.minimize(),
      maximize: async () => resolve().window.maximize(),
      close: async () => resolve().window.close(),
      getState: async () => resolve().window.getState(),
    },
    network: {
      getState: async () => resolve().network.getState(),
      saveAndRestart: async (input, discard) => resolve().network.saveAndRestart(input, discard),
      restoreDefaultAndRestart: async () => resolve().network.restoreDefaultAndRestart(),
      reloadSystemProxy: async () => resolve().network.reloadSystemProxy(),
      test: async request => resolve().network.test(request),
      getDiagnostics: async () => resolve().network.getDiagnostics(),
      retryLastFailure: async () => resolve().network.retryLastFailure(),
      removeManualPassword: async () => resolve().network.removeManualPassword(),
      subscribe: callback => resolve().network.subscribe(callback),
    },
  }
}

/** The `ctx.desktop` capability adapter over the typed preload bridge. */
export class DesktopCapabilitiesService extends Service implements DesktopCapabilitiesContract {
  readonly runtimes: DesktopCapabilitiesContract['runtimes']
  readonly app: DesktopCapabilitiesContract['app']
  readonly dialog: DesktopCapabilitiesContract['dialog']
  readonly clipboard: DesktopCapabilitiesContract['clipboard']
  readonly shell: DesktopCapabilitiesContract['shell']
  readonly notification: DesktopCapabilitiesContract['notification']
  readonly updater: DesktopCapabilitiesContract['updater']
  readonly theme: DesktopCapabilitiesContract['theme']
  readonly window: DesktopCapabilitiesContract['window']
  readonly network: DesktopCapabilitiesContract['network']

  /**
   * @param ctx - Client root context.
   */
  constructor(ctx: Context) {
    super(ctx, 'desktop')
    const capabilities = createLazyDesktopCapabilities()
    this.runtimes = capabilities.runtimes
    this.app = capabilities.app
    this.dialog = capabilities.dialog
    this.clipboard = capabilities.clipboard
    this.shell = capabilities.shell
    this.notification = capabilities.notification
    this.updater = capabilities.updater
    this.theme = capabilities.theme
    this.window = capabilities.window
    this.network = capabilities.network
  }
}
