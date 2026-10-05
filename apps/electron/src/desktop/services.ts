import type { RuntimeManager } from '../toolchains/manager.ts'
/**
 * Main-process desktop capability services behind the typed IPC bridge.
 */

import {
  clipboard,
  dialog,
  nativeTheme,
  Notification,
  shell,
  type BrowserWindow as BrowserWindowType,
} from 'electron'
import type {
  DesktopNotificationOptions,
  DesktopNotificationResult,
  DesktopUpdaterSnapshot,
  PickDirectoryOptions,
  PickDirectoryResult,
  ThemeState,
  WindowState,
} from '../bridge-types.ts'
import {
  directoryOpenDialogOptions,
  isAllowedExternalUrl,
  normalizeShellPath,
  pickDirectoryResult,
  requireClipboardText,
  requireNotificationOptions,
  themeState,
  updaterSnapshot,
  windowState,
} from './index.ts'
import type { UpdaterController } from '../updater.ts'
import type { DesktopNetworkController } from '../network/controller.ts'
import type { DesktopNetworkConfigInput, DesktopNetworkTestRequest } from '../network/domain.ts'

/** Dependencies injected once the main window and updater exist. */
export interface DesktopServicesOptions {
  getRuntimes: () => RuntimeManager | undefined
  /** Resolve the live main BrowserWindow. */
  getWindow: () => BrowserWindowType | undefined
  /** Resolve the updater controller after it is created. */
  getUpdater: () => UpdaterController | undefined
  /** Resolve the Main-owned network controller after startup. */
  getNetwork: () => DesktopNetworkController | undefined
  /** Focus and restore the main window (notification click, tray). */
  showMainWindow: () => void
  /** Drain Host and relaunch the packaged Desktop process. */
  relaunch: () => Promise<void>
}

type ThemeListener = (state: ThemeState) => void
type UpdaterListener = (state: DesktopUpdaterSnapshot) => void

/** Owns OS desktop operations invoked only from trusted renderer IPC. */
export class DesktopServices {
  private readonly options: DesktopServicesOptions
  private readonly themeListeners = new Set<ThemeListener>()
  private readonly updaterListeners = new Set<UpdaterListener>()
  private themeHookInstalled = false

  /** Resolve the Main-owned runtime manager; never construct one in a renderer. */
  runtimes(): RuntimeManager {
    const manager = this.options.getRuntimes()
    if (manager === undefined) throw new Error('desktop runtimes: manager unavailable')
    return manager
  }

  private network(): DesktopNetworkController {
    const controller = this.options.getNetwork()
    if (controller === undefined) throw new Error('desktop network: controller is unavailable')
    return controller
  }

  /** @returns password-free network settings. */
  getNetworkState() { return this.network().state() }

  /** @returns password-free policy and runtime diagnostics. */
  getNetworkDiagnostics() { return this.network().diagnostics() }

  /** Save only a Main-validated configuration before restarting. */
  saveNetworkAndRestart(input: DesktopNetworkConfigInput, discardUnavailablePassword: boolean): Promise<void> {
    return this.network().saveAndRestart(input, { discardUnavailablePassword })
  }

  /** Restore Default and relaunch. */
  restoreNetworkDefaultAndRestart(): Promise<void> { return this.network().restoreDefaultAndRestart() }

  /** Refresh System policy in the current process. */
  reloadSystemProxy() { return this.network().reloadSystemProxy() }

  /** Run incident-free connection probes. */
  testNetwork(request: DesktopNetworkTestRequest) { return this.network().test(request) }

  /** Permit another attempt on the selected route. */
  retryNetworkFailure() { return this.network().retryLastVisibleFailure() }

  /** Delete the retained Manual password. */
  removeManualPassword() { return this.network().removeManualPassword() }

  /** Subscribe to sanitized network state. */
  subscribeNetwork(listener: Parameters<DesktopNetworkController['subscribe']>[0]) { return this.network().subscribe(listener) }

  /**
   * @param options - Window / updater accessors owned by main.ts.
   */
  constructor(options: DesktopServicesOptions) {
    this.options = options
  }

  /** Drain Host and relaunch Desktop so pending plugin composition applies. */
  relaunch(): Promise<void> {
    return this.options.relaunch()
  }

  /** Open the OS directory chooser. */
  async pickDirectory(options: PickDirectoryOptions = {}): Promise<PickDirectoryResult | null> {
    const parent = this.options.getWindow()
    const dialogOptions = directoryOpenDialogOptions(options)
    const result = parent === undefined
      ? await dialog.showOpenDialog(dialogOptions)
      : await dialog.showOpenDialog(parent, dialogOptions)
    return pickDirectoryResult(result.canceled, result.filePaths)
  }

  /** Read system clipboard text. */
  readClipboardText(): Promise<string> {
    return Promise.resolve(clipboard.readText())
  }

  /** Write system clipboard text. */
  async writeClipboardText(text: unknown): Promise<void> {
    await clipboard.writeText(requireClipboardText(text))
  }

  /** Open an allowlisted URL externally. */
  async openExternal(url: unknown): Promise<void> {
    if (typeof url !== 'string' || !isAllowedExternalUrl(url)) {
      throw new Error('desktop shell: URL protocol is not allowed')
    }
    await shell.openExternal(url)
  }

  /** Open a local path with the OS default application. */
  async openPath(path: unknown): Promise<void> {
    const normalized = typeof path === 'string' ? normalizeShellPath(path) : undefined
    if (normalized === undefined) throw new Error('desktop shell: path is invalid')
    const error = await shell.openPath(normalized)
    if (error.length > 0) throw new Error(`desktop shell: openPath failed (${error})`)
  }

  /** Reveal a local path in the file manager. */
  showItemInFolder(path: unknown): Promise<void> {
    const normalized = typeof path === 'string' ? normalizeShellPath(path) : undefined
    if (normalized === undefined) throw new Error('desktop shell: path is invalid')
    shell.showItemInFolder(normalized)
    return Promise.resolve()
  }

  /** Show an OS notification; click restores the main window. */
  showNotification(raw: unknown): Promise<DesktopNotificationResult> {
    const options = requireNotificationOptions(raw)
    if (!Notification.isSupported()) {
      return Promise.resolve({ shown: false, unsupported: true })
    }
    const notification = new Notification({
      title: options.title,
      ...(options.body === undefined ? {} : { body: options.body }),
    })
    notification.on('click', () => {
      this.options.showMainWindow()
    })
    notification.show()
    return Promise.resolve({ shown: true })
  }

  /** Trigger an updater check. */
  async updaterCheck(): Promise<void> {
    await this.options.getUpdater()?.check(true)
    this.emitUpdater()
  }

  /** Download is owned by electron-updater autoDownload; keep as explicit no-op success. */
  updaterDownload(): Promise<void> {
    this.emitUpdater()
    return Promise.resolve()
  }

  /** Install a downloaded update. */
  async updaterInstall(): Promise<void> {
    await this.options.getUpdater()?.installDownloaded()
  }

  /** Current updater snapshot. */
  getUpdaterState(): DesktopUpdaterSnapshot {
    const updater = this.options.getUpdater()
    if (updater === undefined) {
      return { state: 'idle' }
    }
    return updaterSnapshot(updater.state, updater.progress, updater.channel)
  }

  /**
   * Subscribe to updater snapshots. Returns an unsubscribe function.
   * @param listener - Callback invoked on state changes and immediately once.
   */
  subscribeUpdater(listener: UpdaterListener): () => void {
    this.updaterListeners.add(listener)
    listener(this.getUpdaterState())
    return () => { this.updaterListeners.delete(listener) }
  }

  /** Notify updater subscribers (called from main when menus refresh). */
  emitUpdater(): void {
    const snapshot = this.getUpdaterState()
    for (const listener of this.updaterListeners) listener(snapshot)
  }

  /** Current native theme snapshot. */
  getThemeState(): ThemeState {
    const source = nativeTheme.themeSource
    const themeSource = source === 'light' || source === 'dark' ? source : 'system'
    return themeState(nativeTheme.shouldUseDarkColors, themeSource)
  }

  /**
   * Subscribe to native theme updates.
   * @param listener - Callback invoked on change and immediately once.
   */
  subscribeTheme(listener: ThemeListener): () => void {
    this.ensureThemeHook()
    this.themeListeners.add(listener)
    listener(this.getThemeState())
    return () => { this.themeListeners.delete(listener) }
  }

  minimizeWindow(): Promise<void> {
    this.options.getWindow()?.minimize()
    return Promise.resolve()
  }

  maximizeWindow(): Promise<void> {
    const window = this.options.getWindow()
    if (window === undefined) return Promise.resolve()
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return Promise.resolve()
  }

  closeWindow(): Promise<void> {
    this.options.getWindow()?.close()
    return Promise.resolve()
  }

  getWindowState(): WindowState {
    const window = this.options.getWindow()
    if (window === undefined || window.isDestroyed()) {
      return windowState({
        isMinimized: false,
        isMaximized: false,
        isFullScreen: false,
        isVisible: false,
        isFocused: false,
      })
    }
    return windowState({
      isMinimized: window.isMinimized(),
      isMaximized: window.isMaximized(),
      isFullScreen: window.isFullScreen(),
      isVisible: window.isVisible(),
      isFocused: window.isFocused(),
    })
  }

  private ensureThemeHook(): void {
    if (this.themeHookInstalled) return
    this.themeHookInstalled = true
    nativeTheme.on('updated', () => {
      const snapshot = this.getThemeState()
      for (const listener of this.themeListeners) listener(snapshot)
    })
  }
}

/** Validate pick-directory options from IPC. */
export function parsePickDirectoryOptions(value: unknown): PickDirectoryOptions {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object') throw new Error('desktop dialog: options must be an object')
  const record = value as Record<string, unknown>
  return {
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(typeof record.defaultPath === 'string' ? { defaultPath: record.defaultPath } : {}),
  }
}

export type { DesktopNotificationOptions }
