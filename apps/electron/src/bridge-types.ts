import type { RuntimeCapability } from './toolchains/domain.ts'
/**
 * Typed desktop bridge shared by the Electron preload and main process.
 * Channel names are closed; the renderer never receives a generic invoke API.
 */

import type {
  DesktopNotificationOptions,
  DesktopNotificationResult,
  PickDirectoryOptions,
  PickDirectoryResult,
  ThemeState,
  WindowState,
  DesktopUpdaterSnapshot,
} from './desktop/index.ts'
import type {
  DesktopNetworkConfigInput, DesktopNetworkDiagnostics, DesktopNetworkReloadResult,
  DesktopNetworkRetryResult, DesktopNetworkState, DesktopNetworkTestRequest,
  DesktopNetworkTestResult,
} from './network/domain.ts'
import type { DesktopNetworkErrorCode } from './network/errors.ts'

/** Privileged custom scheme that owns the packaged renderer origin. */
export const RENDERER_SCHEME = 'dsh-electron'

/** Origin loaded by BrowserWindow (`hostname` stays loopback for upstream UI gates). */
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://localhost`

/** Production entry URL for the Electron-owned renderer. */
export const RENDERER_ENTRY_URL = `${RENDERER_ORIGIN}/index.html`

/** Closed IPC channel set for the desktop bridge. */
export const DesktopIpcChannel = {
  runtimesGetState: 'desktop:runtimes:get-state',
  runtimesInstall: 'desktop:runtimes:install',
  runtimesCancel: 'desktop:runtimes:cancel',
  runtimesRemove: 'desktop:runtimes:remove',
  runtimesCompleteOnboarding: 'desktop:runtimes:complete-onboarding',
  runtimesSubscribe: 'desktop:runtimes:subscribe',
  getBootstrap: 'deepseek-desktop:host:getBootstrap',
  request: 'deepseek-desktop:host:request',
  openStream: 'deepseek-desktop:host:openStream',
  getVersion: 'deepseek-desktop:app:getVersion',
  getPlatform: 'deepseek-desktop:app:getPlatform',
  relaunch: 'deepseek-desktop:app:relaunch',
  pickDirectory: 'deepseek-desktop:dialog:pickDirectory',
  clipboardReadText: 'deepseek-desktop:clipboard:readText',
  clipboardWriteText: 'deepseek-desktop:clipboard:writeText',
  shellOpenExternal: 'deepseek-desktop:shell:openExternal',
  shellOpenPath: 'deepseek-desktop:shell:openPath',
  shellShowItemInFolder: 'deepseek-desktop:shell:showItemInFolder',
  notificationShow: 'deepseek-desktop:notification:show',
  updaterCheck: 'deepseek-desktop:updater:check',
  updaterDownload: 'deepseek-desktop:updater:download',
  updaterInstall: 'deepseek-desktop:updater:install',
  updaterGetState: 'deepseek-desktop:updater:getState',
  updaterSubscribe: 'deepseek-desktop:updater:subscribe',
  themeGetState: 'deepseek-desktop:theme:getState',
  themeSubscribe: 'deepseek-desktop:theme:subscribe',
  windowMinimize: 'deepseek-desktop:window:minimize',
  windowMaximize: 'deepseek-desktop:window:maximize',
  windowClose: 'deepseek-desktop:window:close',
  windowGetState: 'deepseek-desktop:window:getState',
  networkGetState: 'deepseek-desktop:network:getState',
  networkSaveAndRestart: 'deepseek-desktop:network:saveAndRestart',
  networkRestoreDefaultAndRestart: 'deepseek-desktop:network:restoreDefaultAndRestart',
  networkReloadSystemProxy: 'deepseek-desktop:network:reloadSystemProxy',
  networkTest: 'deepseek-desktop:network:test',
  networkGetDiagnostics: 'deepseek-desktop:network:getDiagnostics',
  networkRetryLastFailure: 'deepseek-desktop:network:retryLastFailure',
  networkRemoveManualPassword: 'deepseek-desktop:network:removeManualPassword',
  networkSubscribe: 'deepseek-desktop:network:subscribe',
} as const

/** Host boot payload extracted from the supervised dsh web index HTML. */
export interface HostBootstrap {
  /** Raw `__DSH_BOOT__` graph object from Host index injection. */
  boot: unknown
  /** Classic-script URLs the Host would preload before the shell (same-origin `/plugins/...`). */
  preloadUrls: string[]
}

/** Unary HTTP request forwarded through the main-process Harness proxy. */
export interface HostHttpRequest {
  /** Absolute or origin-relative URL resolved against the renderer origin. */
  url: string
  /** HTTP method. */
  method: string
  /** Request headers as a plain object (Headers are not structured-clone friendly). */
  headers: Record<string, string>
  /** Optional body text; binary bodies use protocol proxy instead of IPC. */
  body?: string
}

/** Unary HTTP response returned to the renderer through IPC. */
export interface HostHttpResponse {
  /** HTTP status code. */
  status: number
  /** Response status text. */
  statusText: string
  /** Response headers as a plain object. */
  headers: Record<string, string>
  /** Response body text. */
  body: string
}

/** Stream control messages carried on the MessagePort opened for Host event paths. */
export type HostStreamPortMessage =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'close' }
  | { type: 'error'; message: string }
  | { type: 'send'; data: string }
  | { type: 'abort' }

/**
 * Renderer callbacks for a Host event stream. The MessagePort stays in preload
 * (contextBridge cannot return a live MessagePort to the isolated world).
 */
export interface HostStreamHandlers {
  /** Real Host WebSocket reached OPEN. */
  onOpen(): void
  /** Text frame from the Host WebSocket. */
  onMessage(data: string): void
  /** Stream closed (Host or abort). */
  onClose(): void
  /** Bridge or Host error; followed by {@link onClose}. */
  onError(message: string): void
}

/** Renderer control handle for one bidirectional Host WebSocket. */
export interface HostStreamHandle {
  /** Send one text frame to the Host. */
  send(data: string): void
  /** Close the renderer side and abort the Host socket. */
  close(): void
}

/** Unsubscribe handle returned by bridge subscriptions. */
export type DesktopUnsubscribe = () => void

/** Renderer-facing desktop bridge installed as `window.deepseekDesktop`. */
export interface DeepseekDesktopBridge {
  runtimes: RuntimeCapability
  host: {
    /** Fetch Host bootstrap (boot graph + parser preload URLs). */
    getBootstrap(): Promise<HostBootstrap>
    /** Unary Host HTTP request (JSON API paths). */
    request(init: HostHttpRequest): Promise<HostHttpResponse>
    /**
     * Open a Host event stream. Preload owns the MessagePort and fans
     * {@link HostStreamPortMessage} frames into `handlers`; the returned
     * handle sends client frames and aborts the stream.
     */
    openStream(
      path: '/api/remote.mux',
      handlers: HostStreamHandlers,
    ): HostStreamHandle
  }
  app: {
    /** Packaged application version. */
    getVersion(): Promise<string>
    /** Electron `process.platform`. */
    getPlatform(): Promise<string>
    /** Relaunch Desktop after draining Host so pending plugin composition applies. */
    relaunch(): Promise<void>
  }
  dialog: {
    /** Open the OS directory chooser owned by Electron Main. */
    pickDirectory(options?: PickDirectoryOptions): Promise<PickDirectoryResult | null>
  }
  clipboard: {
    /** Read text from the system clipboard. */
    readText(): Promise<string>
    /** Write text to the system clipboard. */
    writeText(text: string): Promise<void>
  }
  shell: {
    /** Open an allowlisted URL with the OS default handler. */
    openExternal(url: string): Promise<void>
    /** Open a local path with the OS default application. */
    openPath(path: string): Promise<void>
    /** Reveal a local path in the OS file manager. */
    showItemInFolder(path: string): Promise<void>
  }
  notification: {
    /** Show an OS notification; click handling stays in Main. */
    show(options: DesktopNotificationOptions): Promise<DesktopNotificationResult>
  }
  updater: {
    /** Request an update check. */
    check(): Promise<void>
    /** Request download of an available update (no-op when auto-download owns it). */
    download(): Promise<void>
    /** Request install of a downloaded update (`quitAndInstall` stays in Main). */
    install(): Promise<void>
    /** Read the current updater snapshot. */
    getState(): Promise<DesktopUpdaterSnapshot>
    /** Subscribe to updater snapshot changes. */
    subscribe(callback: (state: DesktopUpdaterSnapshot) => void): DesktopUnsubscribe
  }
  theme: {
    /** Read the current native theme snapshot. */
    getState(): Promise<ThemeState>
    /** Subscribe to native theme changes. */
    subscribe(callback: (state: ThemeState) => void): DesktopUnsubscribe
  }
  window: {
    /** Minimize the main window. */
    minimize(): Promise<void>
    /** Toggle maximize on the main window. */
    maximize(): Promise<void>
    /** Close (hide-to-tray) the main window. */
    close(): Promise<void>
    /** Read the current window snapshot. */
    getState(): Promise<WindowState>
  }
  network: {
    /** Read sanitized Desktop network settings and runtime state. */
    getState(): Promise<DesktopNetworkState>
    /** Persist a validated configuration and relaunch. */
    saveAndRestart(input: DesktopNetworkConfigInput, discardUnavailablePassword?: boolean): Promise<void>
    /** Persist Default and relaunch while retaining the last Manual endpoint. */
    restoreDefaultAndRestart(): Promise<void>
    /** Refresh the active System policy without changing Desktop mode. */
    reloadSystemProxy(): Promise<DesktopNetworkReloadResult>
    /** Run explicit diagnostic probes without creating a failure incident. */
    test(request: DesktopNetworkTestRequest): Promise<DesktopNetworkTestResult>
    /** Read sanitized policy and failure details. */
    getDiagnostics(): Promise<DesktopNetworkDiagnostics>
    /** Permit another attempt on the current selected route. */
    retryLastFailure(): Promise<DesktopNetworkRetryResult>
    /** Delete the saved Manual password without changing the active route. */
    removeManualPassword(): Promise<void>
    /** Observe sanitized state changes. */
    subscribe(callback: (state: DesktopNetworkState) => void): DesktopUnsubscribe
  }
}

/** Structured save result preserves secure-storage failure codes through Electron IPC. */
export type NetworkSaveWireResult = { ok: true } | { ok: false; error: { code: DesktopNetworkErrorCode; message: string } }

export type {
  DesktopNotificationOptions,
  DesktopNotificationResult,
  PickDirectoryOptions,
  PickDirectoryResult,
  ThemeState,
  WindowState,
  DesktopUpdaterSnapshot,
}

declare global {
  interface Window {
    /** Typed desktop bridge; undefined outside the Electron renderer. */
    deepseekDesktop?: DeepseekDesktopBridge
  }
}
