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
  desktopWindowTitle,
  isAllowedExternalUrl,
} from './desktop/index.ts'
import { DesktopServices } from './desktop/services.ts'
import { stopHarness, type HarnessStopReport } from './harness/process.ts'
import { mergeMainShutdownFacts } from './harness/shutdown-report.ts'
import {
  captureExitCheckpoint,
  consumePendingSessionRestores,
  convergeDesktopRestoreJournals,
  detectUnreadableSessions,
  queueSessionRestore,
  resolveSessionRefusal,
  restoreCheckpointSession,
  type DesktopSessionMaintenanceOptions,
} from './checkpoint/index.ts'
import type { CheckpointSessionEntry } from './checkpoint/manifest.ts'
import { createRestoreJournalDecisions, runStartupSessionMaintenance } from './checkpoint/startup.ts'
import { detectFormatRefusalFrame, type SessionRefusalHit } from './checkpoint/refusal.ts'
import { dequeuePendingRestore } from './checkpoint/pending.ts'
import { deleteRestoreJournal, listRestoreJournals, readRestoreJournal, restoreJournalsDir } from './checkpoint/journal.ts'
import { resolveRestoreClosure, type RestoreOutcome } from './checkpoint/restore.ts'
import {
  buildDeferredJournalsGate,
  buildNoCheckpointNotice,
  buildOrphanedJournalGate,
  buildRestoreConfirm,
  buildRestoreConflictNotice,
  buildRestoreNotice,
  formatRestoreRefusal,
  refusalLabel,
  type RestoreDialogOptions,
} from './checkpoint/dialog.ts'
import { HttpHarnessTransport } from './harness/transport.ts'
import { installDesktopIpc } from './ipc.ts'
import { readDesktopManifest, resolveUpdateRepository, usesStoreUpdates } from './manifest.ts'
import { microsoftStoreUpdateMenu } from './store-update-menu.ts'
import { RENDERER_ENTRY_URL, RENDERER_ORIGIN } from './bridge-types.ts'
import { DesktopPreferencesStore, loadUpdateChannel, saveUpdateChannel, type UpdateChannel } from './preferences.ts'
import { mergeLaunchPathHistory } from './path-history.ts'
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
import { formatDesktopMessage, resolveDesktopMainLocale } from './locale.ts'
import {
  trayIconNeedsLogicalLoad,
  trayIconPath,
  trayIconPixelSize,
  trayIconRasterScale,
  trayIconSize,
} from './tray.ts'
import { createUpdater, updaterNetworkSession, type UpdaterController } from './updater.ts'
import process from 'node:process'

type HarnessProcess = ChildProcessByStdio<null, Readable, Readable>

let harness: HarnessProcess | undefined
/** `$DSH_HOME` of the supervised run; set before Host spawn, read by exit merging. */
let harnessHome: string | undefined
let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let updater: UpdaterController | undefined
const storeManaged = usesStoreUpdates(readDesktopManifest(app.getAppPath()), process.windowsStore)
let runtimes: RuntimeManager | undefined
let ecosystemSetup: { abort: AbortController; done: Promise<void> } | undefined
let network: DesktopNetworkController | undefined
let electronProxy: ElectronProxyApplier | undefined
let networkDialogQueue: Promise<void> = Promise.resolve()
let credentialPromptQueue: Promise<void> = Promise.resolve()
let restoreDialogQueue: Promise<void> = Promise.resolve()
/** Refusal keys already prompted this run — one dialog per session, never repeated. */
const promptedRefusals = new Set<string>()
/** Runtime resolved at startup; the manual rollback entry reuses it for the worker. */
let activeHostRuntime: HostRuntime | undefined
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
      ipc: true,
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
      const timeoutError = new Error(`Rivetdeck did not become ready within ${String(HARNESS_START_TIMEOUT_MS / 1000)} seconds.`)
      void stopHarness(child).then(async (report) => {
        await recordHarnessShutdown(child.pid, report)
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
      // The listener stays armed past readiness, so every child exit — early
      // crash, external kill, or clean drain — leaves its result on record;
      // prepareToInstall's own observation then merges signal/timeout/kill.
      void recordHarnessShutdown(child.pid, {
        signal: null,
        timeout: false,
        kill: false,
        exitCode: code,
        signalCode: signal,
      })
      fail(new Error(`Rivetdeck exited before startup (code ${String(code)}, signal ${String(signal)}).`))
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
    title: app.name,
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
  // AppFrame falls back to upstream `brand.localBuild` ("DSH 本地构建") when
  // client packages were built without DSH_CLIENT_TITLE; keep the Dock / frame
  // product segment on the Desktop productName instead.
  window.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    window.setTitle(desktopWindowTitle(title, app.name))
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

/**
 * Merge Main's supervision facts onto the Host's shutdown report.
 * @param pid - Child pid the observation describes; absent when spawn failed.
 * @param report - Facts `stopHarness` observed while draining the child.
 */
async function recordHarnessShutdown(pid: number | undefined, report: HarnessStopReport): Promise<void> {
  const home = harnessHome
  if (home === undefined || pid === undefined) return
  try {
    await mergeMainShutdownFacts(home, {
      pid,
      signal: report.signal,
      timeout: report.timeout,
      kill: report.kill,
      exitCode: report.exitCode,
      signalCode: report.signalCode,
    })
  } catch (error) {
    console.error('desktop shutdown: failed to merge Harness exit report', error)
  }
}

async function prepareToInstall(): Promise<void> {
  quitting = true
  stopping = true
  ecosystemSetup?.abort.abort()
  await ecosystemSetup?.done
  await transport.stop()
  const child = harness
  harness = undefined
  if (child !== undefined) {
    const report = await stopHarness(child)
    await recordHarnessShutdown(child.pid, report)
    // Exit checkpoint capture: the promotable shutdown report plus per-session
    // read-path validation gates promotion. Failures and the capture deadline
    // must never block or fail quit.
    const home = harnessHome
    if (home !== undefined && child.pid !== undefined) {
      await captureExitCheckpoint({
        home,
        childPid: child.pid,
        appPath: app.getAppPath(),
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appVersion: app.getVersion(),
        log: (message) => { console.error(`desktop checkpoint: ${message}`) },
      }).then((outcome) => {
        if (outcome.kind === 'committed') {
          console.error(`desktop checkpoint: committed ${outcome.id} (${outcome.sessions} sessions)`)
        } else {
          console.error(`desktop checkpoint: ${outcome.kind} — ${outcome.reason}`)
        }
      }).catch((error: unknown) => {
        console.error('desktop checkpoint: capture failed', error)
      })
    }
  }
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

/** Show one restore-related dialog, windowed when the main window exists. */
async function presentRestoreDialog(options: RestoreDialogOptions): Promise<number> {
  const spec = {
    type: options.type,
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons: [...options.buttons],
    defaultId: options.defaultId,
    cancelId: options.cancelId,
  }
  const shown = mainWindow === undefined
    ? dialog.showMessageBox(spec)
    : dialog.showMessageBox(mainWindow, spec)
  return (await shown).response
}

/** Report a finished restore outcome once; conflicts and refusals stay visible until dismissed. */
async function notifyRestoreOutcome(sessionId: string, outcome: RestoreOutcome): Promise<void> {
  const { messages } = resolveDesktopMainLocale(app.getLocale())
  const spec = ((): RestoreDialogOptions | undefined => {
    switch (outcome.kind) {
      case 'restored':
        return buildRestoreNotice(messages, messages.sessionRestoreDoneTitle,
          formatDesktopMessage(messages.sessionRestoreDoneBody,
            { id: sessionId, checkpoint: outcome.checkpointId, quarantine: join(harnessHome ?? '', outcome.quarantine) }))
      case 'refused':
        return buildRestoreNotice(messages, messages.sessionRestoreRefusedTitle,
          formatDesktopMessage(messages.sessionRestoreRefusedBody,
            { id: sessionId, reason: formatRestoreRefusal(messages, outcome.reason) }))
      case 'conflicted':
        return buildRestoreConflictNotice(messages, {
          conflict: outcome.conflict, journalId: outcome.journalId,
          quarantine: join(harnessHome ?? '', outcome.quarantine),
        })
      case 'failed':
        return buildRestoreNotice(messages, messages.sessionRestoreFailedTitle,
          formatDesktopMessage(messages.sessionRestoreFailedBody, { id: sessionId, reason: outcome.reason }))
    }
  })()
  if (spec !== undefined) await presentRestoreDialog(spec)
}

/**
 * Prompt for one confirmed-unreadable session, then run or queue the restore.
 * With the Host down (startup, pending consumption) the transaction runs in
 * place; with the Host up the confirmed intent is persisted and the relaunch
 * reaches the pre-Host window where the entry is legal.
 * @returns `true` when the intent was queued and the caller should relaunch.
 */
async function offerSessionRestore(options: {
  readonly sessionId: string
  readonly checkpointId: string
  readonly members: readonly CheckpointSessionEntry[]
  readonly maintenance: DesktopSessionMaintenanceOptions
}): Promise<boolean> {
  const home = harnessHome
  if (home === undefined) return false
  const locale = resolveDesktopMainLocale(app.getLocale())
  const spec = buildRestoreConfirm(locale.messages, locale.id, {
    sessionId: options.sessionId,
    members: options.members,
    quarantine: join(home, 'electron', 'quarantine'),
    requiresRelaunch: harness !== undefined,
    productName: app.name,
  })
  if ((await presentRestoreDialog(spec)) !== 0) return false
  if (harness !== undefined) {
    await queueSessionRestore(home, options.sessionId, options.checkpointId)
    console.error(`desktop checkpoint: queued restore of ${options.sessionId} for the next launch`)
    return true
  }
  const maintenance = options.maintenance
  const outcome = await restoreCheckpointSession({
    home: maintenance.home,
    sessionId: options.sessionId,
    checkpointId: options.checkpointId,
    appPath: maintenance.appPath,
    resourcesPath: maintenance.resourcesPath,
    packaged: maintenance.packaged,
    hostRunning: maintenance.hostRunning,
    ...(maintenance.log === undefined ? {} : { log: maintenance.log }),
  })
  await notifyRestoreOutcome(options.sessionId, outcome)
  return false
}

/** Open-time refusal attribution: resolve the session, then prompt once per run. */
async function handleSessionRefusal(hit: SessionRefusalHit): Promise<void> {
  const home = harnessHome
  const runtime = activeHostRuntime
  if (home === undefined || runtime === undefined) return
  const locale = resolveDesktopMainLocale(app.getLocale())
  const resolved = await resolveSessionRefusal(home, hit)
  if (resolved === undefined) {
    await presentRestoreDialog(
      buildNoCheckpointNotice(locale.messages, refusalLabel(hit.sessionId, hit.dirTail)),
    )
    return
  }
  const members = resolveRestoreClosure(resolved.manifest, resolved.entry.sessionId)
  const queued = await offerSessionRestore({
    sessionId: resolved.entry.sessionId,
    checkpointId: resolved.checkpointId,
    members: members ?? [resolved.entry],
    maintenance: {
      home,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged,
      hostRuntime: runtime,
      hostRunning: () => harness !== undefined,
    },
  })
  if (queued) await relaunchDesktop()
}

/** Manual menu/tray entry: rescan drift and offer restore for confirmed unreadable sessions. */
async function requestSessionRollback(): Promise<void> {
  const home = harnessHome
  const runtime = activeHostRuntime
  if (home === undefined || runtime === undefined) return
  const locale = resolveDesktopMainLocale(app.getLocale())
  const maintenance: DesktopSessionMaintenanceOptions = {
    home,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
    hostRuntime: runtime,
    hostRunning: () => harness !== undefined,
  }
  const detected = await detectUnreadableSessions(maintenance).catch((error: unknown) => {
    console.error('desktop checkpoint: manual detection failed', error)
    return undefined
  })
  if (detected === undefined) {
    await presentRestoreDialog(buildRestoreNotice(locale.messages,
      locale.messages.sessionRestoreFailedTitle, locale.messages.sessionRestoreScanFailedBody))
    return
  }
  if (detected.unreadable.length === 0) {
    await presentRestoreDialog(buildRestoreNotice(locale.messages,
      locale.messages.sessionRestoreNoneTitle, locale.messages.sessionRestoreNoneBody))
    return
  }
  let relaunchPending = false
  for (const item of detected.unreadable) {
    const members = resolveRestoreClosure(detected.manifest, item.sessionId)
    // The relaunch waits until every prompt is answered so a queued intent
    // never silently drops a later confirmation.
    relaunchPending = await offerSessionRestore({
      sessionId: item.sessionId,
      checkpointId: detected.manifest.id,
      members: members ?? [item.entry],
      maintenance,
    }) || relaunchPending
  }
  if (relaunchPending) await relaunchDesktop()
}

/** Resolve interrupted restore work, requiring an explicit decision before Host launch. */
async function gateRestoreJournals(
  home: string,
  appPath: string,
  decisions: ReturnType<typeof createRestoreJournalDecisions>,
): Promise<boolean> {
  let convergence = await convergeDesktopRestoreJournals({
    home,
    appPath,
    log: (message) => { console.error(`desktop checkpoint: ${message}`) },
  }).catch((error: unknown) => {
    console.error('desktop checkpoint: journal convergence failed', error)
    return undefined
  })
  // A failed sweep may leave uninspected journals over partial file switches
  // or incomplete cache invalidation. Unreadable journal counts also require
  // an explicit startup decision.
  let deferred = await decisions('deferred', convergence?.deferred ?? [])
  let deferredCount = (convergence === undefined ? undefined : deferred.length)
    ?? await listRestoreJournals(home).then(paths => paths.length).catch(() => 1)
  while (deferredCount > 0) {
    const response = await presentRestoreDialog(
      buildDeferredJournalsGate(
        resolveDesktopMainLocale(app.getLocale()).messages,
        deferredCount,
      ),
    )
    if (response === 2) {
      requestQuit()
      return false
    }
    if (response === 0) {
      const retry = await convergeDesktopRestoreJournals({
        home,
        appPath,
        log: (message) => { console.error(`desktop checkpoint: ${message}`) },
      }).catch((error: unknown) => {
        console.error('desktop checkpoint: journal convergence retry failed', error)
        return undefined
      })
      if (retry !== undefined) {
        convergence = retry
        deferred = await decisions('deferred', retry.deferred)
        deferredCount = deferred.length
      }
      continue
    }
    for (const decision of deferred) decision.acknowledge()
    console.error(
      `desktop checkpoint: ${deferredCount} restore journal(s) left deferred by user choice`,
    )
    break
  }
  // An intent whose checkpoint is gone cannot finish; keeping it allows a
  // later launch to resume if the checkpoint is recovered from a backup.
  if (convergence !== undefined) {
    for (const decision of await decisions('unresolvable', convergence.unresolvable)) {
      const journalId = decision.id
      const journal = await readRestoreJournal(join(restoreJournalsDir(home), `${journalId}.json`))
      const response = await presentRestoreDialog(buildOrphanedJournalGate(
        resolveDesktopMainLocale(app.getLocale()).messages,
        {
          checkpointId: journal?.checkpointId ?? journalId,
          quarantine: join(home, journal?.quarantine ?? 'electron/quarantine'),
        },
      ))
      if (response === 2) {
        requestQuit()
        return false
      }
      if (response === 0) {
        if (journal?.pendingRequestId !== undefined) {
          await dequeuePendingRestore(home, journal.targetSessionId, journal.pendingRequestId)
        }
        await deleteRestoreJournal(home, journalId).catch((error: unknown) => {
          console.error(`desktop checkpoint: failed to abandon restore journal ${journalId}`, error)
        })
        console.error(`desktop checkpoint: abandoned unresolvable restore journal ${journalId}`)
      }
      decision.acknowledge()
    }
  }
  // A conflict can leave part of the closure replaced; surface it before
  // the Host reads those sessions.
  if (convergence !== undefined) {
    for (const decision of await decisions('conflicted', convergence.conflicted)) {
      const journalId = decision.id
      const journal = await readRestoreJournal(join(restoreJournalsDir(home), `${journalId}.json`))
      await notifyRestoreOutcome(journal?.targetSessionId ?? journalId, {
        kind: 'conflicted',
        conflict: journal?.conflict ?? journalId,
        journalId,
        quarantine: journal?.quarantine ?? 'electron/quarantine',
      }).then(() => { decision.acknowledge() }).catch((error: unknown) => {
        console.error('desktop checkpoint: conflict notice failed', error)
      })
    }
  }
  return true
}

function installDesktopMenus(): void {
  const m = resolveDesktopMainLocale(app.getLocale()).messages
  const checkForUpdates = (): void => { void updater?.check(true) }
  const updateItems = storeManaged
    ? microsoftStoreUpdateMenu(m)
    : [updateMenuItem(checkForUpdates), updateChannelMenu()]
  const showAbout = (): void => { void showAboutWindow(mainWindow) }
  const aboutLabel = formatDesktopMessage(m.menuAbout, { name: app.name })
  const showLabel = formatDesktopMessage(m.menuShow, { name: app.name })
  const appMenu: MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [{
      label: app.name,
      submenu: [
        { label: aboutLabel, click: showAbout },
        ...updateItems,
        { label: m.menuSessionRollback, click: () => { void requestSessionRollback() } },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: formatDesktopMessage(m.menuQuitNamed, { name: app.name }),
          accelerator: 'CommandOrControl+Q',
          click: requestQuit,
        },
      ],
    }]
    : [{
      label: m.menuFile,
      submenu: [
        { label: showLabel, click: showMainWindow },
        ...updateItems,
        { label: aboutLabel, click: showAbout },
        { label: m.menuSessionRollback, click: () => { void requestSessionRollback() } },
        { type: 'separator' },
        { label: m.menuQuit, accelerator: 'CommandOrControl+Q', click: requestQuit },
      ],
    }]
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...appMenu,
    { label: m.menuEdit, submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: m.menuView, submenu: [{ role: 'reload' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : [])] },
  ]))

  if (tray === undefined) {
    tray = new Tray(createTrayIcon())
    tray.setToolTip(app.name)
    tray.on('click', showMainWindow)
    nativeTheme.on('updated', refreshTrayIcon)
    screen.on('display-metrics-changed', refreshTrayIcon)
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: showLabel, click: showMainWindow },
    ...updateItems,
    { label: aboutLabel, click: showAbout },
    { label: m.menuSessionRollback, click: () => { void requestSessionRollback() } },
    { type: 'separator' },
    { label: m.menuQuit, click: requestQuit },
  ]))
  desktop.emitUpdater()
}

function updateMenuItem(checkForUpdates: () => void): MenuItemConstructorOptions {
  const m = resolveDesktopMainLocale(app.getLocale()).messages
  if (updater?.state === 'checking') return { label: m.menuCheckingUpdates, enabled: false }
  if (updater?.state === 'downloading') {
    return {
      label: updater.progress === undefined
        ? m.menuDownloadingUpdate
        : formatDesktopMessage(m.menuDownloadingUpdateProgress, { progress: updater.progress }),
      enabled: false,
    }
  }
  if (updater?.state === 'downloaded') {
    return { label: m.menuRestartInstall, click: () => { void updater?.installDownloaded() } }
  }
  return { label: m.menuCheckUpdates, click: checkForUpdates }
}

function updateChannelMenu(): MenuItemConstructorOptions {
  const m = resolveDesktopMainLocale(app.getLocale()).messages
  const enabled = updater?.state !== 'checking'
    && updater?.state !== 'downloading'
    && updater?.state !== 'downloaded'
  const select = (channel: UpdateChannel): void => {
    updater?.setChannel(channel)
    void updater?.check(true)
  }
  return {
    label: m.menuUpdateChannel,
    submenu: [
      { label: m.menuChannelPrerelease, type: 'radio', checked: updater?.channel === 'prerelease', enabled, click: () => { select('prerelease') } },
      { label: m.menuChannelStable, type: 'radio', checked: updater?.channel === 'stable', enabled, click: () => { select('stable') } },
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
    harnessHome = process.env.DSH_HOME ?? resolveHarnessHome(app.getPath('home'))
    // Record the resolved roots before the fallible startup steps: a launch that dies in
    // network or runtime preparation must still leave this launch's paths in history.
    if (process.platform === 'win32' && app.isPackaged) {
      await mergeLaunchPathHistory({
        appDataDir: app.getPath('appData'),
        userData: userDataPath,
        dshHome: harnessHome,
      }).catch((error: unknown) => {
        console.error('desktop path history recording failed', error)
      })
    }
    network = new DesktopNetworkController({
      userDataPath,
      preferences: new DesktopPreferencesStore(userDataPath),
      secrets: new SafeStorageSecretStore(join(userDataPath, 'network-secrets'), safeStorage),
      relaunch: relaunchDesktop,
      diagnosticFetch: async (url, signal) => {
        const response = await updaterNetworkSession(storeManaged).fetch(url, { method: 'GET', redirect: 'manual', signal })
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
    if (networkState.effectiveMode !== 'default') await electronProxy.register(updaterNetworkSession(storeManaged), 'updater')
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
    activeHostRuntime = hostRuntime
    // Open-time refusal sniffing: `SessionFormatUnsupportedError` reaches the
    // renderer as a `gateway/internal` stream failure; the observer matches the
    // stable message text and queues one restore prompt per session per run.
    transport.harnessProxy.onStreamText = (data) => {
      if (quitting) return
      const hit = detectFormatRefusalFrame(data)
      if (hit === undefined) return
      const key = hit.sessionId ?? hit.dirTail
      if (key === undefined || promptedRefusals.has(key)) return
      promptedRefusals.add(key)
      restoreDialogQueue = restoreDialogQueue
        .then(() => handleSessionRefusal(hit))
        .catch((error: unknown) => {
          console.error('desktop checkpoint: open-time restore prompt failed', error)
        })
    }
    // Pending restores confirmed during the last run execute in this pre-Host
    // window; then stat-diff + vN scan + worker confirmation surface foreign
    // writes and offer an in-place restore before the Host can read live data.
    const sessionMaintenance: DesktopSessionMaintenanceOptions = {
      home: harnessHome,
      appPath,
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged,
      hostRuntime,
      hostRunning: () => harness !== undefined,
      log: (message) => { console.error(`desktop checkpoint: ${message}`) },
    }
    const canStart = await runStartupSessionMaintenance({
      home: sessionMaintenance.home,
      gate: decisions => gateRestoreJournals(sessionMaintenance.home, appPath, decisions),
      maintain: async () => {
        for (const pending of await consumePendingSessionRestores(sessionMaintenance)) {
          await notifyRestoreOutcome(pending.sessionId, pending.outcome)
        }
        const detected = await detectUnreadableSessions(sessionMaintenance)
        if (detected !== undefined) {
          for (const item of detected.unreadable) {
            const members = resolveRestoreClosure(detected.manifest, item.sessionId)
            await offerSessionRestore({
              sessionId: item.sessionId,
              checkpointId: detected.manifest.id,
              members: members ?? [item.entry],
              maintenance: sessionMaintenance,
            })
          }
        }
      },
      onError: (error) => { console.error('desktop checkpoint: startup session maintenance failed', error) },
    })
    if (!canStart) return
    const shim = prepareToolchainShims({ userData: userDataPath, harnessHome }, toolchains, process.platform)
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
      }).finally(() => { console.info('desktop ecosystem profile setup settled') }),
    }
    const repository = resolveUpdateRepository(readDesktopManifest(app.getAppPath()))
    if (!storeManaged && repository === undefined) throw new Error('The packaged GitHub update repository is missing.')
    if (repository !== undefined) updater = createUpdater({
      storeManaged,
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
    void updater?.check(false)
  }).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox(`${app.name} failed to start`, message)
    await prepareToInstall().catch(() => undefined)
    requestQuit()
  })
}
