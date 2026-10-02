import { requireRuntimeName } from './toolchains/domain.ts'
/**
 * Typed ipcMain handlers for the desktop preload bridge.
 */

import { app, ipcMain, type WebContents } from 'electron'
import {
  DesktopIpcChannel,
  type HostHttpRequest,
  type ThemeState,
  type DesktopUpdaterSnapshot,
  type NetworkSaveWireResult,
} from './bridge-types.ts'
import type { DesktopNetworkConfigInput, DesktopNetworkState } from './network/domain.ts'
import { DesktopNetworkConfigError, DesktopNetworkOperationError } from './network/errors.ts'
import { parseNetworkTestRequest } from './network/test-service.ts'
import { DesktopServices, parsePickDirectoryOptions } from './desktop/services.ts'
import type { HarnessTransport } from './harness/transport.ts'
const updaterSubscriptions = new WeakMap<WebContents, () => void>()
const themeSubscriptions = new WeakMap<WebContents, () => void>()
const networkSubscriptions = new WeakMap<WebContents, Set<() => void>>()

/**
 * Register desktop IPC handlers once after the Harness transport exists.
 * @param transport - Main-process Harness transport.
 * @param desktop - Desktop capability services.
 * @param isTrustedContents - Whether the sender owns the main renderer window.
 */
export function installDesktopIpc(
  transport: HarnessTransport,
  desktop: DesktopServices,
  isTrustedContents: (contents: WebContents) => boolean,
): void {
  const guard = (event: Electron.IpcMainInvokeEvent): void => {
    if (!isTrustedContents(event.sender)) {
      throw new Error('desktop ipc: untrusted sender')
    }
  }

  const guardEvent = (event: Electron.IpcMainEvent): boolean => isTrustedContents(event.sender)


  ipcMain.handle(DesktopIpcChannel.runtimesGetState, (event) => { guard(event); return desktop.runtimes().state() })
  ipcMain.handle(DesktopIpcChannel.runtimesInstall, async (event, name: unknown) => {
    guard(event)
    await desktop.runtimes().install(requireRuntimeName(name))
  })
  ipcMain.handle(DesktopIpcChannel.runtimesCancel, async (event, name: unknown) => {
    guard(event)
    await desktop.runtimes().cancel(requireRuntimeName(name))
  })
  ipcMain.handle(DesktopIpcChannel.runtimesRemove, async (event, name: unknown) => {
    guard(event)
    await desktop.runtimes().remove(requireRuntimeName(name))
  })
  ipcMain.handle(DesktopIpcChannel.runtimesCompleteOnboarding, async (event) => {
    guard(event)
    await desktop.runtimes().completeOnboarding()
  })
  ipcMain.on(DesktopIpcChannel.runtimesSubscribe, (event) => {
    if (!guardEvent(event)) return
    const port = event.ports[0]
    if (port === undefined) return
    const unsubscribe = desktop.runtimes().subscribe((snapshot) => {
      try { port.postMessage(snapshot) } catch (error) { console.debug('runtime subscription port closed', error) }
    })
    port.on('close', unsubscribe)
  })

  ipcMain.handle(DesktopIpcChannel.getBootstrap, async (event) => {
    guard(event)
    return await transport.getBootstrap()
  })

  ipcMain.handle(DesktopIpcChannel.request, async (event, init: HostHttpRequest) => {
    guard(event)
    return await transport.request(init)
  })

  ipcMain.handle(DesktopIpcChannel.getVersion, (event) => {
    guard(event)
    return app.getVersion()
  })

  ipcMain.handle(DesktopIpcChannel.getPlatform, (event) => {
    guard(event)
    return process.platform
  })

  ipcMain.handle(DesktopIpcChannel.relaunch, async (event) => {
    guard(event)
    await desktop.relaunch()
  })

  ipcMain.handle(DesktopIpcChannel.pickDirectory, async (event, options: unknown) => {
    guard(event)
    return await desktop.pickDirectory(parsePickDirectoryOptions(options))
  })

  ipcMain.handle(DesktopIpcChannel.clipboardReadText, async (event) => {
    guard(event)
    return await desktop.readClipboardText()
  })

  ipcMain.handle(DesktopIpcChannel.clipboardWriteText, async (event, text: unknown) => {
    guard(event)
    await desktop.writeClipboardText(text)
  })

  ipcMain.handle(DesktopIpcChannel.shellOpenExternal, async (event, url: unknown) => {
    guard(event)
    await desktop.openExternal(url)
  })

  ipcMain.handle(DesktopIpcChannel.shellOpenPath, async (event, path: unknown) => {
    guard(event)
    await desktop.openPath(path)
  })

  ipcMain.handle(DesktopIpcChannel.shellShowItemInFolder, async (event, path: unknown) => {
    guard(event)
    await desktop.showItemInFolder(path)
  })

  ipcMain.handle(DesktopIpcChannel.notificationShow, async (event, options: unknown) => {
    guard(event)
    return await desktop.showNotification(options)
  })

  ipcMain.handle(DesktopIpcChannel.updaterCheck, async (event) => {
    guard(event)
    await desktop.updaterCheck()
  })

  ipcMain.handle(DesktopIpcChannel.updaterDownload, async (event) => {
    guard(event)
    await desktop.updaterDownload()
  })

  ipcMain.handle(DesktopIpcChannel.updaterInstall, async (event) => {
    guard(event)
    await desktop.updaterInstall()
  })

  ipcMain.handle(DesktopIpcChannel.updaterGetState, (event) => {
    guard(event)
    return desktop.getUpdaterState()
  })

  ipcMain.handle(DesktopIpcChannel.themeGetState, (event) => {
    guard(event)
    return desktop.getThemeState()
  })

  ipcMain.handle(DesktopIpcChannel.windowMinimize, async (event) => {
    guard(event)
    await desktop.minimizeWindow()
  })

  ipcMain.handle(DesktopIpcChannel.windowMaximize, async (event) => {
    guard(event)
    await desktop.maximizeWindow()
  })

  ipcMain.handle(DesktopIpcChannel.windowClose, async (event) => {
    guard(event)
    await desktop.closeWindow()
  })

  ipcMain.handle(DesktopIpcChannel.windowGetState, (event) => {
    guard(event)
    return desktop.getWindowState()
  })

  ipcMain.handle(DesktopIpcChannel.networkGetState, (event) => {
    guard(event)
    return desktop.getNetworkState()
  })

  ipcMain.handle(DesktopIpcChannel.networkSaveAndRestart, async (
    event, input: unknown, discard: unknown,
  ): Promise<NetworkSaveWireResult> => {
    guard(event)
    if (discard !== undefined && typeof discard !== 'boolean') throw new Error('desktop network: invalid save option')
    try {
      await desktop.saveNetworkAndRestart(input as DesktopNetworkConfigInput, discard === true)
      return { ok: true }
    } catch (error) {
      const known = error instanceof DesktopNetworkConfigError || error instanceof DesktopNetworkOperationError
      return { ok: false, error: { code: known ? error.code : 'UNKNOWN',
        message: known ? error.message : 'Network settings could not be saved.' } }
    }
  })

  ipcMain.handle(DesktopIpcChannel.networkRestoreDefaultAndRestart, async (event) => {
    guard(event)
    await desktop.restoreNetworkDefaultAndRestart()
  })
  ipcMain.handle(DesktopIpcChannel.networkReloadSystemProxy, async (event) => {
    guard(event)
    return await desktop.reloadSystemProxy()
  })
  ipcMain.handle(DesktopIpcChannel.networkTest, async (event, request: unknown) => {
    guard(event)
    return await desktop.testNetwork(parseNetworkTestRequest(request))
  })
  ipcMain.handle(DesktopIpcChannel.networkGetDiagnostics, async (event) => {
    guard(event)
    return await desktop.getNetworkDiagnostics()
  })
  ipcMain.handle(DesktopIpcChannel.networkRetryLastFailure, (event) => {
    guard(event)
    return desktop.retryNetworkFailure()
  })
  ipcMain.handle(DesktopIpcChannel.networkRemoveManualPassword, async (event) => {
    guard(event)
    await desktop.removeManualPassword()
  })

  ipcMain.on(DesktopIpcChannel.openStream, (event, path: string) => {
    if (!guardEvent(event)) return
    const port = event.ports[0]
    if (port === undefined) return
    if (path !== '/api/remote.mux') {
      port.postMessage({ type: 'error', message: `desktop ipc: unsupported stream ${path}` })
      port.close()
      return
    }
    transport.openStream(path, port)
  })

  ipcMain.on(DesktopIpcChannel.updaterSubscribe, (event) => {
    if (!guardEvent(event)) return
    const port = event.ports[0]
    if (port === undefined) return
    updaterSubscriptions.get(event.sender)?.()
    const unsubscribe = desktop.subscribeUpdater((state: DesktopUpdaterSnapshot) => {
      try {
        port.postMessage(state)
      } catch {
        // Port closed when the renderer disposed the subscription.
      }
    })
    updaterSubscriptions.set(event.sender, unsubscribe)
    port.on('close', () => {
      unsubscribe()
      updaterSubscriptions.delete(event.sender)
    })
  })

  ipcMain.on(DesktopIpcChannel.themeSubscribe, (event) => {
    if (!guardEvent(event)) return
    const port = event.ports[0]
    if (port === undefined) return
    themeSubscriptions.get(event.sender)?.()
    const unsubscribe = desktop.subscribeTheme((state: ThemeState) => {
      try {
        port.postMessage(state)
      } catch {
        // Port closed when the renderer disposed the subscription.
      }
    })
    themeSubscriptions.set(event.sender, unsubscribe)
    port.on('close', () => {
      unsubscribe()
      themeSubscriptions.delete(event.sender)
    })
  })

  ipcMain.on(DesktopIpcChannel.networkSubscribe, (event) => {
    if (!guardEvent(event)) return
    const port = event.ports[0]
    if (port === undefined) return
    const unsubscribe = desktop.subscribeNetwork((state: DesktopNetworkState) => {
      try { port.postMessage(state) } catch { /* Renderer disposed the subscription. */ }
    })
    const subscriptions = networkSubscriptions.get(event.sender) ?? new Set<() => void>()
    subscriptions.add(unsubscribe)
    networkSubscriptions.set(event.sender, subscriptions)
    port.on('close', () => {
      unsubscribe()
      subscriptions.delete(unsubscribe)
      if (subscriptions.size === 0) networkSubscriptions.delete(event.sender)
    })
  })
}
