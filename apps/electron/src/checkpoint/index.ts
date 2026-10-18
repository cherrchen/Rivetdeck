/**
 * Exit-checkpoint orchestration entry for `main.ts`. Runs after a promotable
 * drain inside `prepareToInstall`, bounded by a deadline so quitting cannot
 * hang on capture; an aborted attempt discards the `.tmp` candidate and never
 * blocks or fails the exit path.
 */

import { join } from 'node:path'
import { runExitCheckpoint, type ExitCheckpointOutcome } from './capture.ts'
import { listRestoreJournals } from './journal.ts'
import {
  convergeRestoreJournals,
  restoreSession,
  type AcquireSessionLease,
  type JournalConvergence,
  type RestoreOutcome,
} from './restore.ts'
import { resolveDshInstallAnchor, resolveHostRuntime, type HostRuntime } from '../runtime.ts'
import { detectCheckpointDrift, confirmUnreadable, type ConfirmedUnreadable } from './detect.ts'
import { dequeuePendingRestore, enqueuePendingRestore, listPendingRestores } from './pending.ts'
import { checkpointsRoot, readManifest, type CheckpointManifest, type CheckpointSessionEntry } from './manifest.ts'
import { mountSessionsBackend, resolveSessionFormatVersion } from './validate.ts'
import { runValidationWorker, validateWorkerModule } from './worker.ts'
import type { SessionRefusalHit } from './refusal.ts'
import { readdir } from 'node:fs/promises'

/** Total wall-clock budget for one exit capture; the deadline kills the validation worker. */
export const CHECKPOINT_CAPTURE_BUDGET_MS = 120_000

/** Startup drift confirmation reuses the capture worker with its own bound. */
export const DETECTION_BUDGET_MS = 90_000

export interface CaptureExitCheckpointOptions {
  /** `$DSH_HOME` the Host ran against. */
  readonly home: string
  /** Pid of the child just drained; binds promotion to this run's report. */
  readonly childPid: number
  /** `app.getAppPath()` of the running Desktop. */
  readonly appPath: string
  /** `app.isPackaged` of the running Desktop. */
  readonly packaged: boolean
  /** `process.resourcesPath` of the running Desktop. */
  readonly resourcesPath: string
  /** `app.getVersion()` recorded as the validator. */
  readonly appVersion: string
  /** Pre-resolved runtime, when the caller already holds it. */
  readonly hostRuntime?: HostRuntime | undefined
  readonly log?: ((message: string) => void) | undefined
}

/** Capture one exit checkpoint when the persisted shutdown report is promotable. */
export async function captureExitCheckpoint(
  options: CaptureExitCheckpointOptions,
): Promise<ExitCheckpointOutcome> {
  const runtime = options.hostRuntime ?? resolveHostRuntime({
    appPath: options.appPath,
    resourcesPath: options.resourcesPath,
    packaged: options.packaged,
    override: process.env.DSH_ELECTRON_NODE_BINARY,
  })
  const anchor = resolveDshInstallAnchor(options.appPath)
  const workerModule = validateWorkerModule(options.appPath)
  const timeout = AbortSignal.timeout(CHECKPOINT_CAPTURE_BUDGET_MS)
  return runExitCheckpoint({
    home: options.home,
    childPid: options.childPid,
    appVersion: options.appVersion,
    signal: timeout,
    log: options.log,
    validate: (sessionsRoot, signal) =>
      runValidationWorker(workerModule, sessionsRoot, anchor, runtime, signal),
  })
}

/**
 * Lease acquisition through the live backend's `acquireWriteLease` seam — the
 * same kernel lock (`session.lock`) the Host honors, so acquisition fails
 * while any writer holds the session.
 */
async function backendLeaseAcquirer(home: string, installAnchor: string): Promise<{
  acquire: AcquireSessionLease
  dispose(): Promise<void>
}> {
  const mounted = await mountSessionsBackend(join(home, 'sessions'), installAnchor)
  return {
    acquire: member => mounted.persistence.acquireWriteLease(member.header),
    dispose: () => mounted.dispose(),
  }
}

/**
 * Converge leftover restore journals before the Host spawns. The no-journals
 * fast path returns without loading the backend. Journals that cannot
 * converge — held leases, missing checkpoints, per-journal failures — come
 * back as `deferred` so the caller can gate startup on them; a throw means
 * the sweep itself failed before inspecting every journal.
 */
export async function convergeDesktopRestoreJournals(options: {
  readonly home: string
  readonly appPath: string
  readonly signal?: AbortSignal | undefined
  readonly log?: ((message: string) => void) | undefined
}): Promise<JournalConvergence> {
  if ((await listRestoreJournals(options.home)).length === 0) {
    return { converged: [], conflicted: [], deferred: [], unresolvable: [] }
  }
  const leases = await backendLeaseAcquirer(options.home, resolveDshInstallAnchor(options.appPath))
  try {
    return await convergeRestoreJournals({
      home: options.home,
      acquireLease: leases.acquire,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.log === undefined ? {} : { log: options.log }),
    })
  } finally {
    await leases.dispose()
  }
}

/**
 * Restore one session plus its related-source closure from the newest
 * verified checkpoint. Runs in a Host-down window; the caller supplies the
 * local-Host guard.
 */
export async function restoreCheckpointSession(options: {
  readonly home: string
  readonly sessionId: string
  readonly checkpointId?: string | undefined
  readonly appPath: string
  readonly resourcesPath: string
  readonly packaged: boolean
  readonly hostRunning?: (() => boolean) | undefined
  readonly log?: ((message: string) => void) | undefined
}): Promise<RestoreOutcome> {
  const anchor = resolveDshInstallAnchor(options.appPath)
  const runtime = resolveHostRuntime({
    appPath: options.appPath,
    resourcesPath: options.resourcesPath,
    packaged: options.packaged,
    override: process.env.DSH_ELECTRON_NODE_BINARY,
  })
  const workerModule = validateWorkerModule(options.appPath)
  const leases = await backendLeaseAcquirer(options.home, anchor)
  try {
    return await restoreSession({
      home: options.home,
      sessionId: options.sessionId,
      ...(options.checkpointId === undefined ? {} : { checkpointId: options.checkpointId }),
      ...(options.hostRunning === undefined ? {} : { hostRunning: options.hostRunning }),
      acquireLease: leases.acquire,
      validate: (sessionsRoot, signal) => runValidationWorker(workerModule, sessionsRoot, anchor, runtime, signal),
      ...(options.log === undefined ? {} : { log: options.log }),
    })
  } finally {
    await leases.dispose()
  }
}

export interface DesktopSessionMaintenanceOptions {
  readonly home: string
  readonly appPath: string
  readonly resourcesPath: string
  readonly packaged: boolean
  /** Resolved once by startup; re-used by detection so the worker exec is identical. */
  readonly hostRuntime: HostRuntime
  /** Local-Host guard handed to every restore entry. */
  readonly hostRunning: () => boolean
  readonly log?: ((message: string) => void) | undefined
}

function restoreOptions(options: DesktopSessionMaintenanceOptions, sessionId: string): {
  readonly home: string
  readonly sessionId: string
  readonly appPath: string
  readonly resourcesPath: string
  readonly packaged: boolean
  readonly hostRunning: () => boolean
  readonly log: ((message: string) => void) | undefined
} {
  return {
    home: options.home,
    sessionId,
    appPath: options.appPath,
    resourcesPath: options.resourcesPath,
    packaged: options.packaged,
    hostRunning: options.hostRunning,
    log: options.log,
  }
}

/** Outcome of one consumed pending request, for caller-side notification. */
export interface PendingRestoreResult {
  readonly sessionId: string
  readonly outcome: RestoreOutcome
}

/**
 * Execute user-confirmed restores queued while the Host was up. Runs inside
 * the same pre-Host window as journal convergence, so `hostRunning` stays
 * false and lease acquisition is the live-writer proof. Failures surface to
 * the caller; they never block startup.
 */
export async function consumePendingSessionRestores(
  options: DesktopSessionMaintenanceOptions,
): Promise<PendingRestoreResult[]> {
  const results: PendingRestoreResult[] = []
  for (const request of await listPendingRestores(options.home)) {
    const outcome = await restoreCheckpointSession(restoreOptions(options, request.sessionId))
    // The entry leaves the queue only after the attempt resolves: a crash
    // here keeps this and every later request durable for the next launch.
    await dequeuePendingRestore(options.home, request.sessionId)
    results.push({ sessionId: request.sessionId, outcome })
    options.log?.(`pending restore ${request.sessionId}: ${outcome.kind}`)
  }
  return results
}

/**
 * Startup detection: stat-diff plus the `session.vN` scan against the newest
 * checkpoint, then worker confirmation on the live sessions root. Returns
 * only sessions confirmed unreadable AND holding a verified copy — the set a
 * confirmation prompt may offer to restore.
 * @param options.confirmIdleLease - Set while a writer may be live (the local
 *   Host is up): a torn mid-append read then reports a healthy session as
 *   unreadable, so only candidates whose `session.lock` write lease can be
 *   acquired — proving no writer — keep the verdict.
 */
export async function detectUnreadableSessions(
  options: DesktopSessionMaintenanceOptions & { readonly confirmIdleLease?: boolean | undefined },
): Promise<{ manifest: CheckpointManifest; unreadable: readonly ConfirmedUnreadable[] } | undefined> {
  const anchor = resolveDshInstallAnchor(options.appPath)
  const formatVersion = await resolveSessionFormatVersion(anchor).catch(() => undefined)
  const detection = await detectCheckpointDrift(options.home, { formatVersion })
  if (detection === undefined) return undefined
  if (detection.candidates.length === 0) return { manifest: detection.manifest, unreadable: [] }
  options.log?.(`drift detected against checkpoint ${detection.checkpointId}: ${detection.candidates.map(c => c.dir).join(', ')}`)
  const workerModule = validateWorkerModule(options.appPath)
  const report = await runValidationWorker(
    workerModule,
    join(options.home, 'sessions'),
    anchor,
    options.hostRuntime,
    AbortSignal.timeout(DETECTION_BUDGET_MS),
  )
  const unreadable = confirmUnreadable(detection, report)
  if (options.confirmIdleLease !== true || unreadable.length === 0) {
    return { manifest: detection.manifest, unreadable }
  }
  const leases = await backendLeaseAcquirer(options.home, anchor)
  try {
    return { manifest: detection.manifest, unreadable: await filterIdleWriters(unreadable, leases.acquire, options.log) }
  } finally {
    await leases.dispose()
  }
}

/**
 * Drop confirmed-unreadable candidates that cannot prove the absence of a
 * live writer: a held lease means a mid-append torn read may have produced
 * the verdict. A header-less entry cannot be leased at all and drops under
 * the same "unverifiable while writers may be live" rule.
 */
export async function filterIdleWriters(
  candidates: readonly ConfirmedUnreadable[],
  acquireLease: AcquireSessionLease,
  log?: ((message: string) => void) | undefined,
): Promise<readonly ConfirmedUnreadable[]> {
  const confirmed: ConfirmedUnreadable[] = []
  for (const item of candidates) {
    if (item.entry.header === undefined) {
      log?.(`drift candidate ${item.dir} skipped: no stored header to lease against`)
      continue
    }
    try {
      const lease = await acquireLease({ sessionId: item.sessionId, dir: item.dir, header: item.entry.header })
      await lease.release()
      confirmed.push(item)
    } catch (error) {
      log?.(`drift candidate ${item.dir} skipped: write lease held by a live writer (${(error as Error).message})`)
    }
  }
  return confirmed
}

/**
 * Attribute an open-time refusal frame to a checkpointed session. The raw id
 * matches `sessionId` directly; the `raw log:` path names the encoded dir
 * tail. Only a session with a verified copy is actionable.
 * @returns The newest manifest entry for the session, or undefined.
 */
export async function resolveSessionRefusal(
  home: string,
  hit: SessionRefusalHit,
): Promise<{ checkpointId: string; manifest: CheckpointManifest; entry: CheckpointSessionEntry } | undefined> {
  let names: string[]
  try {
    names = await readdir(checkpointsRoot(home))
  } catch {
    return undefined
  }
  for (const name of names.filter(entry => !entry.endsWith('.tmp')).sort().reverse()) {
    const manifest = await readManifest(join(checkpointsRoot(home), name))
    if (manifest === undefined) continue
    const entry = manifest.sessions.find(candidate => candidate.sessionId === hit.sessionId)
      ?? (hit.dirTail === undefined
        ? undefined
        : manifest.sessions.find(candidate => candidate.dir.split('/').pop() === hit.dirTail))
    if (entry !== undefined) return { checkpointId: manifest.id, manifest, entry }
  }
  return undefined
}

/** Record one open-time confirmed intent for the next launch's pre-Host window. */
export async function queueSessionRestore(home: string, sessionId: string): Promise<void> {
  await enqueuePendingRestore(home, sessionId)
}
