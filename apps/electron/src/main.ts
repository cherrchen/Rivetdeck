/**
 * Electron desktop entry. It supervises the upstream dsh Web backend as a
 * Main-only compatibility process, loads the Electron-owned renderer over
 * `dsh-electron://localhost`, and owns desktop OS capabilities.
 */

import { readFileSync } from 'node:fs'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  safeStorage,
  screen,
  session,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron'
import { showAboutWindow } from './about.ts'
import {
  allowsClipboardWrite,
  contextMenuTemplate,
  desktopWindowChrome,
  isAllowedExternalUrl,
} from './desktop/index.ts'
import { DesktopServices } from './desktop/services.ts'
import { stopHarness } from './harness/process.ts'
import { HttpHarnessTransport } from './harness/transport.ts'
import { installDesktopIpc } from './ipc.ts'
import { readDesktopManifest, resolveUpdateRepository } from './manifest.ts'
import { RENDERER_ENTRY_URL, RENDERER_ORIGIN } from './bridge-types.ts'
import { DesktopPreferencesStore, loadUpdateChannel, saveUpdateChannel, type UpdateChannel } from './preferences.ts'
import { DesktopNetworkController } from './network/controller.ts'
import { ElectronProxyApplier } from './network/electron-proxy.ts'
import { presentNetworkFailure } from './network/failure-dialog.ts'
import { presentCredentialChallenge } from './network/credential-window.ts'
import { NetworkRuntimeClient } from './network/runtime-client.ts'
import { SafeStorageSecretStore } from './network/secret-store.ts'
import {
  installRendererProtocol,
  registerRendererScheme,
  resolveRendererRoot,
} from './protocol.ts'
import { prepareCoreProfile, prepareEcosystemProfile } from './ecosystem-profile.ts'
import { prepareHostRuntimeOverlay } from './runtime-overlay.ts'
import {
  HARNESS_START_TIMEOUT_MS,
  harnessArguments,
  resolveHostModule,
  resolveHarnessHome,
  resolveHostRuntime,
  scanHarnessStartupChunk,
  spawnHarnessChild,
  type HarnessStartupScan,
  type HostRuntime,
} from './runtime.ts'
import { preparePluginPackageManager, resolveBundledPnpmBin } from './plugin-package-manager.ts'
import { RuntimeManager } from './toolchains/manager.ts'
import { createRuntimeFetch } from './toolchains/download.ts'
import { prepareToolchainShims } from './toolchains/shims.ts'
import type { DesktopToolchainPolicy } from './toolchains/domain.ts'
import { migrateLegacyPluginState } from './legacy-plugin-migration.ts'
import { resolveDesktopMainLocale } from './locale.ts'
import {
  trayIconNeedsLogicalLoad,
  trayIconPath,
  trayIconPixelSize,
  trayIconRasterScale,
  trayIconSize,
} from './tray.ts'
import { createUpdater, updaterNetworkSession, type UpdaterController } from './updater.ts'
import * as process from 'node:process'

type HarnessProcess = ChildProcessByStdio<null, Readable, Readable>

let harness: HarnessProcess | undefined
let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let updater: UpdaterController | undefined
let runtimes: RuntimeManager | undefined
let ecosystemSetup: { abort: AbortController; done: Promise<void> } | undefined
let network: DesktopNetworkController | undefined
let electronProxy: ElectronProxyApplier | undefined
let networkDialogQueue: Promise<void> = Promise.resolve()
let credentialPromptQueue: Promise<void> = Promise.resolve()
let quitting = false
let stopping = false
const transport = new HttpHarnessTransport()
const desktop = new DesktopServices({
  getWindow: () => mainWindow,
  getUpdater: () => updater,
  getNetwork: () => network,
  getRuntimes: () => runtimes,
  showMainWindow,
  relaunch: relaunchDesktop,
})

registerRendererScheme()

/** Start the Desktop Host and resolve only after its complete Web composition is ready. */
async function startHarness(
  runtime: HostRuntime,
  appPath: string,
  harnessHome: string,
  hostPatch: string,
  envPath: string,
  toolchainPolicy: DesktopToolchainPolicy,
): Promise<{ child: HarnessProcess; url: string }> {
  const activeNetwork = network
  if (activeNetwork === undefined) throw new Error('desktop network: controller is unavailable')
  const agentPolicy = activeNetwork.agentProxyPolicyForHost(process.env)
  const child = spawnHarnessChild(
    runtime.executable,
    harnessArguments(appPath, resolveHostModule(appPath), hostPatch),
    {
      cwd: app.getPath('home'),
      env: activeNetwork.environmentForHarness({
        ...process.env,
        DSH_HOME: harnessHome,
        ...runtime.env,
        PATH: envPath,
        DSH_ELECTRON_AGENT_PROXY_POLICY: agentPolicy,
        DSH_ELECTRON_TOOLCHAIN_POLICY: JSON.stringify(toolchainPolicy),
      }),
    },
  )

  return await new Promise((resolve, reject) => {
    const scan: HarnessStartupScan = { output: '', settled: false }
    const timer = setTimeout(() => {
      if (scan.settled) return
      scan.settled = true
      scan.output = ''
      const timeoutError = new Error(`DeepSeek Harness did not become ready within ${String(HARNESS_START_TIMEOUT_MS / 1000)} seconds.`)
      void stopHarness(child).then(() => {
        reject(timeoutError)
      }, (cleanupError: unknown) => {
        reject(new AggregateError([timeoutError, cleanupError], `${timeoutError.message} Harness shutdown also failed.`))
      })
    }, HARNESS_START_TIMEOUT_MS)

    const fail = (error: Error): void => {
      if (scan.settled) return
      scan.settled = true
      scan.output = ''
      clearTimeout(timer)
      reject(error)
    }

    child.once('error', fail)
    child.once('exit', (code, signal) => {
      fail(new Error(`DeepSeek Harness exited before startup (code ${String(code)}, signal ${String(signal)}).`))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      process.stdout.write(text)
      const url = scanHarnessStartupChunk(scan, text)
      if (url === undefined) return
      clearTimeout(timer)
      resolve({ child, url })
    })
    child.stderr.on('data', (chunk: Buffer) => { process.stderr.write(chunk) })
  })
}

/** Open one hardened desktop window for the Electron-owned renderer. */
async function createWindow(): Promise<BrowserWindow> {
  const allowedOrigin = RENDERER_ORIGIN
  const preload = join(app.getAppPath(), 'lib', 'preload', 'index.cjs')
  const window = new BrowserWindow({
    ...desktopWindowChrome(process.platform),
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f8f9fb',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`desktop preload failed (${preloadPath}):`, error)
  })
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    window.hide()
  })
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.webContents.on('will-navigate', (event, nextUrl) => {
    if (safeOrigin(nextUrl) !== allowedOrigin) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    if (isAllowedExternalUrl(nextUrl)) void desktop.openExternal(nextUrl)
    return { action: 'deny' }
  })
  window.webContents.on('context-menu', (_event, params) => {
    Menu.buildFromTemplate(contextMenuTemplate(params, !app.isPackaged)).popup({ window })
  })

  // Clipboard OS access goes through desktop.clipboard; keep a narrow write
  // allowance until the renderer shim is the only writer in packaged builds.
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    contents === window.webContents
      && allowsClipboardWrite(permission, requestingOrigin, allowedOrigin))
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === window.webContents
      && allowsClipboardWrite(permission, safeOrigin(details.requestingUrl), allowedOrigin))
  })

  await window.loadURL(RENDERER_ENTRY_URL)
  window.show()
  return window
}

function showMainWindow(): void {
  const window = mainWindow
  if (window === undefined || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function requestQuit(): void {
  quitting = true
  app.quit()
}

async function prepareToInstall(): Promise<void> {
  quitting = true
  stopping = true
  ecosystemSetup?.abort.abort()
  await ecosystemSetup?.done
  await transport.stop()
  const child = harness
  harness = undefined
  if (child !== undefined) await stopHarness(child)
  await runtimes?.shutdown()
  await network?.shutdown().catch(() => undefined)
}

/** Stop Host cleanly, then relaunch this Desktop process. */
async function relaunchDesktop(): Promise<void> {
  app.relaunch()
  try {
    await prepareToInstall()
  } catch (error) {
    console.error('desktop relaunch: failed to drain Host before exit', error)
  }
  app.exit(0)
}

function installDesktopMenus(): void {
  const checkForUpdates = (): void => { void updater?.check(true) }
  const installOrCheck = updateMenuItem(checkForUpdates)
  const updateChannel = updateChannelMenu()
  const showAbout = (): void => { void showAboutWindow(mainWindow) }
  const appMenu: MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [{
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: showAbout },
        installOrCheck,
        updateChannel,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${app.name}`, accelerator: 'CommandOrControl+Q', click: requestQuit },
      ],
    }]
    : [{
      label: 'File',
      submenu: [
        { label: `Show ${app.name}`, click: showMainWindow },
        installOrCheck,
        updateChannel,
        { label: `About ${app.name}`, click: showAbout },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CommandOrControl+Q', click: requestQuit },
      ],
    }]
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...appMenu,
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : [])] },
  ]))

  if (tray === undefined) {
    tray = new Tray(createTrayIcon())
    tray.setToolTip(app.name)
    tray.on('click', showMainWindow)
    nativeTheme.on('updated', refreshTrayIcon)
    screen.on('display-metrics-changed', refreshTrayIcon)
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Show ${app.name}`, click: showMainWindow },
    installOrCheck,
    updateChannel,
    { label: `About ${app.name}`, click: showAbout },
    { type: 'separator' },
    { label: 'Quit', click: requestQuit },
  ]))
  desktop.emitUpdater()
}

function updateMenuItem(checkForUpdates: () => void): MenuItemConstructorOptions {
  if (updater?.state === 'checking') return { label: 'Checking for Updates…', enabled: false }
  if (updater?.state === 'downloading') {
    return {
      label: updater.progress === undefined
        ? 'Downloading Update…'
        : `Downloading Update… ${String(updater.progress)}%`,
      enabled: false,
    }
  }
  if (updater?.state === 'downloaded') {
    return { label: 'Restart to Install Update', click: () => { void updater?.installDownloaded() } }
  }
  return { label: 'Check for Updates…', click: checkForUpdates }
}

function updateChannelMenu(): MenuItemConstructorOptions {
  const enabled = updater?.state !== 'checking'
    && updater?.state !== 'downloading'
    && updater?.state !== 'downloaded'
  const select = (channel: UpdateChannel): void => {
    updater?.setChannel(channel)
    void updater?.check(true)
  }
  return {
    label: 'Update Channel',
    submenu: [
      { label: 'Pre-Release', type: 'radio', checked: updater?.channel === 'prerelease', enabled, click: () => { select('prerelease') } },
      { label: 'Stable / Release', type: 'radio', checked: updater?.channel === 'stable', enabled, click: () => { select('stable') } },
    ],
  }
}

function createTrayIcon(): Electron.NativeImage {
  const trayDir = join(app.getAppPath(), 'build', 'tray')
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(join(trayDir, 'deepseekTemplate.png'))
    if (icon.isEmpty()) throw new Error('The packaged tray icon could not be loaded.')
    const retina = nativeImage.createFromPath(join(trayDir, 'deepseekTemplate@2x.png'))
    if (!retina.isEmpty()) {
      const { width, height } = retina.getSize()
      icon.addRepresentation({ scaleFactor: 2, width, height, buffer: retina.toPNG() })
    }
    icon.setTemplateImage(true)
    return icon
  }

  const scaleFactor = screen.getPrimaryDisplay().scaleFactor
  const dip = trayIconSize(process.platform)
  const pixel = trayIconPixelSize(dip, scaleFactor)
  const path = trayIconPath(
    app.getAppPath(),
    process.platform,
    nativeTheme.shouldUseDarkColors,
    scaleFactor,
  )
  const icon = trayIconNeedsLogicalLoad(process.platform, dip, pixel)
    ? nativeImage.createFromBuffer(readFileSync(path), {
      width: dip,
      height: dip,
      scaleFactor: trayIconRasterScale(dip, pixel),
    })
    : nativeImage.createFromPath(path)
  if (icon.isEmpty()) throw new Error('The packaged tray icon could not be loaded.')
  return icon
}

function refreshTrayIcon(): void {
  if (tray === undefined || tray.isDestroyed()) return
  tray.setImage(createTrayIcon())
}

function safeOrigin(value: string): string {
  try { return new URL(value).origin } catch { return '' }
}

app.on('window-all-closed', () => {})
app.on('activate', showMainWindow)
app.on('second-instance', showMainWindow)
app.on('before-quit', (event) => {
  if (stopping || harness === undefined) return
  event.preventDefault()
  void prepareToInstall().catch((error: unknown) => {
    console.error('desktop quit: failed to drain Host before exit', error)
  }).finally(() => { app.quit() })
})

const userDataOverride = app.commandLine.getSwitchValue('user-data-dir')
if (userDataOverride !== '') app.setPath('userData', resolve(userDataOverride))

const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) {
  app.quit()
} else {
  void app.whenReady().then(async () => {
    installRendererProtocol(resolveRendererRoot(app.getAppPath()), transport.harnessProxy)
    const appPath = app.getAppPath()
    const userDataPath = app.getPath('userData')
    network = new DesktopNetworkController({
      userDataPath,
      preferences: new DesktopPreferencesStore(userDataPath),
      secrets: new SafeStorageSecretStore(join(userDataPath, 'network-secrets'), safeStorage),
      relaunch: relaunchDesktop,
      diagnosticFetch: async (url, signal) => {
        const response = await updaterNetworkSession().fetch(url, { method: 'GET', redirect: 'manual', signal })
        await response.body?.cancel()
        // HTTPS responses are inside CONNECT and can carry origin headers unchanged.
        const networkErrorCode = url.startsWith('http:') ? response.headers.get('x-dsh-network-error') : null
        return { status: response.status, ...(networkErrorCode === null ? {} : { networkErrorCode }) }
      },
      onEpochChanged: () => {
        ecosystemSetup?.abort.abort()
        for (const name of ['node', 'python'] as const) {
          void runtimes?.cancel(name).catch((error: unknown) => {
            console.error('runtime network transition cleanup failed', error)
          })
        }
        void electronProxy?.closeConnections().catch(() => undefined)
      },
      onIncident: (incident) => {
        const activeNetwork = network
        if (activeNetwork === undefined) return
        const messages = resolveDesktopMainLocale(app.getLocale()).messages
        networkDialogQueue = networkDialogQueue.then(async () => {
          if (activeNetwork.state().lastIncident?.id !== incident.id) return
          const action = await presentNetworkFailure({
            incident, messages, ...(mainWindow === undefined ? {} : { window: mainWindow }),
            dialog: { showMessageBox: async (window, options) => window === undefined
              ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options) },
          })
          if (action === 'open-settings') {
            showMainWindow()
            activeNetwork.requestOpenSettings()
          }
          await activeNetwork.handleFailureAction(incident.id, action)
        }).catch(() => undefined)
      },
      onCredentialRequired: (challenge) => {
        const activeNetwork = network
        if (activeNetwork === undefined) return
        credentialPromptQueue = credentialPromptQueue.then(async () => {
          if (!activeNetwork.isPendingChallenge(challenge.id)) return
          const input = await presentCredentialChallenge({
            challenge, locale: resolveDesktopMainLocale(app.getLocale()), appPath,
            ...(mainWindow === undefined ? {} : { parent: mainWindow }),
          })
          await activeNetwork.submitCredential(challenge.id, input)
        }).catch(() => {
          dialog.showErrorBox(resolveDesktopMainLocale(app.getLocale()).messages.networkCredentialTitle,
            resolveDesktopMainLocale(app.getLocale()).messages.networkCredentialFailed)
        })
      },
    })
    await network.prepare()
    const networkRuntime = new NetworkRuntimeClient({
      appPath,
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged,
    })
    await network.startRuntime(networkRuntime)
    electronProxy = new ElectronProxyApplier(app, session.defaultSession)
    const networkState = network.state()
    if (networkState.effectiveMode !== 'default') await electronProxy.register(updaterNetworkSession(), 'updater')
    await electronProxy.apply(networkState.effectiveMode, networkState.runtime.gateway, network.gatewayForUpdater())
    const basePath = process.env.PATH ?? ''
    const runtimeSession = session.fromPartition('runtime-downloads')
    await electronProxy.register(runtimeSession)
    runtimes = new RuntimeManager({ userData: userDataPath, fetch: createRuntimeFetch(runtimeSession) })
    const toolchains = await runtimes.prepare()
    const hostRuntime = resolveHostRuntime({
      appPath,
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged,
      override: process.env.DSH_ELECTRON_NODE_BINARY,
    })
    const harnessHome = process.env.DSH_HOME ?? resolveHarnessHome(app.getPath('home'))
    const shim = prepareToolchainShims(userDataPath, toolchains, process.platform)
    const toolchainPolicy: DesktopToolchainPolicy = {
      version: 2,
      mode: 'fallback',
      basePath,
      ...(toolchains.node === undefined ? {} : {
        node: { executable: toolchains.node.executable, version: toolchains.node.version, binDirectory: toolchains.node.binDirectory },
      }),
      ...(toolchains.python === undefined ? {} : { python: toolchains.python }),
      shimDirectory: shim.shimDirectory,
      pythonUserBase: shim.pythonUserBase,
      nodeGlobalBinDirectory: shim.nodeGlobalBinDirectory,
      pythonUserBinDirectory: shim.pythonUserBinDirectory,
    }
    await migrateLegacyPluginState(harnessHome)
    const pnpmBin = resolveBundledPnpmBin(appPath)
    const packageManager = preparePluginPackageManager(
      harnessHome,
      hostRuntime.executable,
      pnpmBin,
    )
    const corePackageManager = {
      command: hostRuntime.executable,
      args: [pnpmBin],
      env: { ...hostRuntime.env, PATH: packageManager.envPath },
    }
    await prepareCoreProfile(appPath, harnessHome, corePackageManager)
    const overlay = await prepareHostRuntimeOverlay(appPath, userDataPath, harnessHome)
    installDesktopIpc(
      transport,
      desktop,
      contents => mainWindow !== undefined && contents === mainWindow.webContents,
    )
    const started = await startHarness(
      hostRuntime,
      appPath,
      harnessHome,
      overlay.patchPath,
      packageManager.envPath,
      toolchainPolicy,
    )
    harness = started.child
    await transport.start(started.url)
    harness.once('exit', (code, signal) => {
      if (quitting) return
      dialog.showErrorBox(
        `${app.name} stopped`,
        `The local Harness process exited (code ${String(code)}, signal ${String(signal)}).`,
      )
      requestQuit()
    })
    await createWindow()
    const ecosystemAbort = new AbortController()
    const ecosystemPackageManager = { ...corePackageManager, signal: ecosystemAbort.signal }
    ecosystemSetup = {
      abort: ecosystemAbort,
      done: prepareEcosystemProfile(appPath, harnessHome, ecosystemPackageManager).catch((error: unknown) => {
        if (!ecosystemAbort.signal.aborted) {
          console.error('desktop ecosystem profile setup failed; bundled plugins remain available', error)
        }
      }),
    }
    const repository = resolveUpdateRepository(readDesktopManifest(app.getAppPath()))
    if (repository === undefined) throw new Error('The packaged GitHub update repository is missing.')
    updater = createUpdater({
      channel: loadUpdateChannel(userDataPath),
      getWindow: () => mainWindow,
      onChannelChanged: (channel) => {
        void saveUpdateChannel(userDataPath, channel).catch((error: unknown) => {
          console.error('Unable to save desktop preferences', error)
        })
      },
      onStateChanged: installDesktopMenus,
      prepareToInstall,
      repository,
      useManagedSession: networkState.effectiveMode !== 'default',
    })
    installDesktopMenus()
    void updater.check(false)
  }).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox(`${app.name} failed to start`, message)
    await prepareToInstall().catch(() => undefined)
    requestQuit()
  })
}
