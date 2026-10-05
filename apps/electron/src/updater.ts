import type {
  BrowserWindow,
  MessageBoxOptions,
  MessageBoxReturnValue,
} from 'electron'
import { app, dialog, Notification } from 'electron'
import electronUpdater from 'electron-updater'
import {
  formatDesktopMessage,
  resolveDesktopMainLocale,
  type DesktopMainMessages,
} from './locale.ts'
import type { UpdateChannel } from './preferences.ts'
import { resolveUpdateFeed, type UpdateRepository } from './update-feed.ts'

const { autoUpdater } = electronUpdater

/** User-visible updater lifecycle represented in desktop menus. */
type UpdaterState = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error'

export interface UpdaterController {
  check(manual: boolean): Promise<void>
  installDownloaded(): Promise<void>
  setChannel(channel: UpdateChannel): void
  readonly channel: UpdateChannel
  readonly progress: number | undefined
  readonly state: UpdaterState
}

interface UpdaterOptions {
  channel: UpdateChannel
  getWindow: () => BrowserWindow | undefined
  onChannelChanged: (channel: UpdateChannel) => void
  onStateChanged: () => void
  prepareToInstall: () => Promise<void>
  repository: UpdateRepository
  resolveFeed?: typeof resolveUpdateFeed
  useManagedSession?: boolean
}

/** The updater's metadata and download requests share this Electron Session. */
export function updaterNetworkSession(): Electron.Session {
  return autoUpdater.netSession
}

/** Configure GitHub release discovery, background downloads, and manual checks. */
export function createUpdater(options: UpdaterOptions): UpdaterController {
  let channel = options.channel
  let state: UpdaterState = 'idle'
  let progress: number | undefined
  let downloadedVersion: string | undefined
  let lastProgress = -1
  const loggedErrors = new WeakSet<object>()

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = console

  const setState = (nextState: UpdaterState, nextProgress?: number): void => {
    state = nextState
    progress = nextProgress
    options.onStateChanged()
  }

  autoUpdater.on('update-available', () => { setState('downloading', 0) })
  autoUpdater.on('download-progress', (info) => {
    const nextProgress = Math.max(0, Math.min(100, Math.floor(info.percent)))
    if (nextProgress === lastProgress) return
    lastProgress = nextProgress
    setState('downloading', nextProgress)
  })
  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    setState('downloaded')
    notifyDownloaded(app.name, info.version, () => { void controller.installDownloaded() })
  })
  autoUpdater.on('error', (error) => {
    logUpdateError(error, loggedErrors)
    setState('error')
  })

  const controller: UpdaterController = {
    get channel() { return channel },
    get progress() { return progress },
    get state() { return state },
    async check(manual) {
      const parent = options.getWindow()
      const m = mainMessages()
      if (!app.isPackaged) {
        if (manual) await showMessage(parent, {
          type: 'info',
          message: m.updatePackagedOnlyTitle,
          detail: m.updatePackagedOnlyDetail,
        })
        return
      }
      if (state === 'downloaded') {
        if (manual) await promptToInstall(parent, app.name, downloadedVersion, () => controller.installDownloaded())
        return
      }
      if (state === 'checking') {
        if (manual) await showMessage(parent, {
          type: 'info',
          message: m.updateCheckingTitle,
          detail: formatDesktopMessage(m.updateCheckingDetail, { channel: channelLabel(channel, m) }),
        })
        return
      }
      if (state === 'downloading') {
        if (manual) await showMessage(parent, {
          type: 'info',
          message: m.updateDownloadingTitle,
          detail: progress === undefined
            ? m.updateDownloadingDetail
            : formatDesktopMessage(m.updateDownloadingDetailProgress, { progress }),
        })
        return
      }

      setState('checking')
      try {
        const feedUrl = await (options.resolveFeed ?? resolveUpdateFeed)(
          options.repository,
          channel,
          options.useManagedSession ? ((input, init) => updaterNetworkSession().fetch(input as string, init)) : fetch,
        )
        if (feedUrl === undefined) {
          setState('idle')
          if (manual) await showMessage(parent, {
            type: 'info',
            message: formatDesktopMessage(m.updateUpToDate, { name: app.name }),
            detail: formatDesktopMessage(m.updateNoPublishedDetail, { channel: channelLabel(channel, m) }),
          })
          return
        }
        autoUpdater.allowPrerelease = channel === 'prerelease'
        autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
        const result = await autoUpdater.checkForUpdates()
        if (result?.isUpdateAvailable === true) {
          setState('downloading', progress ?? 0)
          if (manual) await showMessage(parent, {
            type: 'info',
            message: m.updateFoundTitle,
            detail: formatDesktopMessage(m.updateFoundDetail, { version: result.updateInfo.version }),
          })
          if (result.downloadPromise !== null && result.downloadPromise !== undefined) {
            void result.downloadPromise.catch((error: unknown) => {
              void handleUpdateError(error, manual, options.getWindow(), setState, loggedErrors)
            })
          }
          return
        }
        setState('idle')
        if (manual) await showMessage(parent, {
          type: 'info',
          message: formatDesktopMessage(m.updateUpToDate, { name: app.name }),
          detail: formatDesktopMessage(m.updateCurrentNewestDetail, {
            version: app.getVersion(),
            channel: channelLabel(channel, m),
          }),
        })
      } catch (error: unknown) {
        await handleUpdateError(error, manual, parent, setState, loggedErrors)
      }
    },
    async installDownloaded() {
      if (state !== 'downloaded') return
      await options.prepareToInstall()
      autoUpdater.quitAndInstall(false, true)
    },
    setChannel(nextChannel) {
      if (state === 'checking' || state === 'downloading' || state === 'downloaded') return
      if (channel === nextChannel) return
      channel = nextChannel
      options.onChannelChanged(channel)
      setState('idle')
    },
  }
  return controller
}

async function handleUpdateError(
  error: unknown,
  manual: boolean,
  parent: BrowserWindow | undefined,
  setState: (state: UpdaterState) => void,
  loggedErrors: WeakSet<object>,
): Promise<void> {
  logUpdateError(error, loggedErrors)
  setState('error')
  if (!manual) return
  const m = mainMessages()
  await showMessage(parent, {
    type: 'error',
    message: m.updateCheckFailedTitle,
    detail: m.updateCheckFailedDetail,
  })
}

function logUpdateError(error: unknown, loggedErrors: WeakSet<object>): void {
  if (typeof error === 'object' && error !== null) {
    if (loggedErrors.has(error)) return
    loggedErrors.add(error)
  }
  console.error('Update check or download failed', error)
}

function mainMessages(): DesktopMainMessages {
  return resolveDesktopMainLocale(app.getLocale()).messages
}

function channelLabel(channel: UpdateChannel, messages: DesktopMainMessages): string {
  return channel === 'prerelease' ? messages.menuChannelPrerelease : messages.menuChannelStable
}

function notifyDownloaded(applicationName: string, version: string, install: () => void): void {
  const m = mainMessages()
  const title = formatDesktopMessage(m.updateReadyNotificationTitle, { name: applicationName })
  const body = formatDesktopMessage(m.updateReadyNotificationBody, { version })
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body })
    notification.on('click', install)
    notification.show()
    return
  }
  void promptToInstall(undefined, applicationName, version, () => {
    install()
    return Promise.resolve()
  })
}

async function promptToInstall(
  parent: BrowserWindow | undefined,
  applicationName: string,
  version: string | undefined,
  install: () => Promise<void>,
): Promise<void> {
  const m = mainMessages()
  const result = await showMessage(parent, {
    type: 'info',
    buttons: [m.updateRestartInstall, m.updateLater],
    defaultId: 0,
    cancelId: 1,
    message: m.updateReadyTitle,
    detail: version === undefined
      ? formatDesktopMessage(m.updateReadyRestartDetail, { name: applicationName })
      : formatDesktopMessage(m.updateReadyVersionDetail, { version, name: applicationName }),
  })
  if (result.response === 0) await install()
}

function showMessage(
  parent: BrowserWindow | undefined,
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  return parent === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options)
}
