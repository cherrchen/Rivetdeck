import type { RuntimeSnapshot } from '../toolchains/domain.ts'
/**
 * Sandboxed preload: expose the typed `deepseekDesktop` bridge only.
 * Built to a single CommonJS file — sandboxed ESM multi-file preloads do not load.
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DesktopIpcChannel,
  type DeepseekDesktopBridge,
  type DesktopUnsubscribe,
  type DesktopUpdaterSnapshot,
  type HostHttpRequest,
  type HostStreamHandlers,
  type HostStreamHandle,
  type HostStreamPortMessage,
  type PickDirectoryOptions,
  type NetworkSaveWireResult,
  type ThemeState,
} from '../bridge-types.ts'
import type { DesktopNetworkConfigInput, DesktopNetworkState, DesktopNetworkTestRequest } from '../network/domain.ts'

function subscribeChannel<T>(
  channel: string,
  callback: (value: T) => void,
  decode: (value: unknown) => T,
): DesktopUnsubscribe {
  const { port1, port2 } = new MessageChannel()
  const onMessage = (event: MessageEvent): void => {
    callback(decode(event.data))
  }
  port2.addEventListener('message', onMessage)
  port2.start()
  ipcRenderer.postMessage(channel, null, [port1])
  return () => {
    port2.removeEventListener('message', onMessage)
    port2.close()
  }
}

/**
 * Bridge a Host event stream while keeping the MessagePort in preload.
 * Returning MessagePort across contextBridge yields a non-functional clone
 * in the isolated world (`addEventListener` missing), which breaks workspace
 * and session baselines that wait on stream `onConnected`.
 * @param path - Host event path.
 * @param handlers - Renderer callbacks (functions cross contextBridge safely).
 * @returns Handle that sends frames and aborts the stream.
 */
function openHostStream(
  path: '/api/remote.mux',
  handlers: HostStreamHandlers,
): HostStreamHandle {
  const { port1, port2 } = new MessageChannel()
  let closed = false
  const cleanup = (): void => {
    if (closed) return
    closed = true
    port2.removeEventListener('message', onMessage)
    try {
      port2.postMessage({ type: 'abort' } satisfies HostStreamPortMessage)
    } catch {
      // Port already closed by Main.
    }
    try {
      port2.close()
    } catch {
      // Port already closed.
    }
  }
  const onMessage = (event: MessageEvent): void => {
    const message = event.data as HostStreamPortMessage
    switch (message.type) {
      case 'open':
        handlers.onOpen()
        break
      case 'message':
        handlers.onMessage(message.data)
        break
      case 'close':
        handlers.onClose()
        cleanup()
        break
      case 'error':
        handlers.onError(message.message)
        handlers.onClose()
        cleanup()
        break
      case 'abort':
      case 'send':
        break
      default: {
        const _exhaustive: never = message
        void _exhaustive
      }
    }
  }
  port2.addEventListener('message', onMessage)
  port2.start()
  ipcRenderer.postMessage(DesktopIpcChannel.openStream, path, [port1])
  return {
    send(data: string): void {
      if (closed) throw new Error('desktop stream: cannot send after close')
      port2.postMessage({ type: 'send', data } satisfies HostStreamPortMessage)
    },
    close: cleanup,
  }
}

const bridge: DeepseekDesktopBridge = {
  runtimes: {
    getState: () => ipcRenderer.invoke(DesktopIpcChannel.runtimesGetState),
    install: name => ipcRenderer.invoke(DesktopIpcChannel.runtimesInstall, name),
    cancel: name => ipcRenderer.invoke(DesktopIpcChannel.runtimesCancel, name),
    remove: name => ipcRenderer.invoke(DesktopIpcChannel.runtimesRemove, name),
    completeOnboarding: () => ipcRenderer.invoke(DesktopIpcChannel.runtimesCompleteOnboarding),
    subscribe: callback => subscribeChannel(DesktopIpcChannel.runtimesSubscribe, callback, value => value as RuntimeSnapshot),
  },
  host: {
    getBootstrap: () => ipcRenderer.invoke(DesktopIpcChannel.getBootstrap),
    request: (init: HostHttpRequest) => ipcRenderer.invoke(DesktopIpcChannel.request, init),
    openStream: openHostStream,
  },
  app: {
    getVersion: () => ipcRenderer.invoke(DesktopIpcChannel.getVersion),
    getPlatform: () => ipcRenderer.invoke(DesktopIpcChannel.getPlatform),
    relaunch: () => ipcRenderer.invoke(DesktopIpcChannel.relaunch),
  },
  dialog: {
    pickDirectory: (options?: PickDirectoryOptions) =>
      ipcRenderer.invoke(DesktopIpcChannel.pickDirectory, options),
  },
  clipboard: {
    readText: () => ipcRenderer.invoke(DesktopIpcChannel.clipboardReadText),
    writeText: (text: string) => ipcRenderer.invoke(DesktopIpcChannel.clipboardWriteText, text),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke(DesktopIpcChannel.shellOpenExternal, url),
    openPath: (path: string) => ipcRenderer.invoke(DesktopIpcChannel.shellOpenPath, path),
    showItemInFolder: (path: string) =>
      ipcRenderer.invoke(DesktopIpcChannel.shellShowItemInFolder, path),
  },
  notification: {
    show: options => ipcRenderer.invoke(DesktopIpcChannel.notificationShow, options),
  },
  updater: {
    check: () => ipcRenderer.invoke(DesktopIpcChannel.updaterCheck),
    download: () => ipcRenderer.invoke(DesktopIpcChannel.updaterDownload),
    install: () => ipcRenderer.invoke(DesktopIpcChannel.updaterInstall),
    getState: () => ipcRenderer.invoke(DesktopIpcChannel.updaterGetState),
    subscribe: (callback: (state: DesktopUpdaterSnapshot) => void) =>
      subscribeChannel(
        DesktopIpcChannel.updaterSubscribe,
        callback,
        value => value as DesktopUpdaterSnapshot,
      ),
  },
  theme: {
    getState: () => ipcRenderer.invoke(DesktopIpcChannel.themeGetState),
    subscribe: (callback: (state: ThemeState) => void) =>
      subscribeChannel(
        DesktopIpcChannel.themeSubscribe,
        callback,
        value => value as ThemeState,
      ),
  },
  window: {
    minimize: () => ipcRenderer.invoke(DesktopIpcChannel.windowMinimize),
    maximize: () => ipcRenderer.invoke(DesktopIpcChannel.windowMaximize),
    close: () => ipcRenderer.invoke(DesktopIpcChannel.windowClose),
    getState: () => ipcRenderer.invoke(DesktopIpcChannel.windowGetState),
  },
  network: {
    getState: () => ipcRenderer.invoke(DesktopIpcChannel.networkGetState),
    saveAndRestart: async (input: DesktopNetworkConfigInput, discardUnavailablePassword = false) => {
      const response = await ipcRenderer.invoke(
        DesktopIpcChannel.networkSaveAndRestart, input, discardUnavailablePassword,
      ) as NetworkSaveWireResult
      if (response.ok) return
      const error = new Error(response.error.message) as Error & { code: string }
      error.code = response.error.code
      throw error
    },
    restoreDefaultAndRestart: () => ipcRenderer.invoke(DesktopIpcChannel.networkRestoreDefaultAndRestart),
    reloadSystemProxy: () => ipcRenderer.invoke(DesktopIpcChannel.networkReloadSystemProxy),
    test: (request: DesktopNetworkTestRequest) => ipcRenderer.invoke(DesktopIpcChannel.networkTest, request),
    getDiagnostics: () => ipcRenderer.invoke(DesktopIpcChannel.networkGetDiagnostics),
    retryLastFailure: () => ipcRenderer.invoke(DesktopIpcChannel.networkRetryLastFailure),
    removeManualPassword: () => ipcRenderer.invoke(DesktopIpcChannel.networkRemoveManualPassword),
    subscribe: (callback: (state: DesktopNetworkState) => void) =>
      subscribeChannel(DesktopIpcChannel.networkSubscribe, callback, value => value as DesktopNetworkState),
  },
}

contextBridge.exposeInMainWorld('deepseekDesktop', bridge)
