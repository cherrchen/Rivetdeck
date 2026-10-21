/**
 * Exit-checkpoint orchestration entry for `main.ts`. Runs after a promotable
 * drain inside `prepareToInstall`. Deadline cancellation leaves unpublished
 * candidates for a later sweep. After publication, cancellation
 * preserves the durability flush and skips or stops retention.
 */

import { join } from 'node:path'
import { runExitCheckpoint, type ExitCheckpointOutcome, type CheckpointValidationReport } from './capture.ts'
import { listRestoreJournals, readRestoreJournal } from './journal.ts'
import {
  convergeRestoreJournals,
  restoreSession,
  resolveRestoreClosure,
  type AcquireSessionLease,
  type ListLiveSessions,
  type JournalConvergence,
  type RestoreOutcome,
} from './restore.ts'
import { resolveDshInstallAnchor, resolveHostRuntime, type HostRuntime } from '../runtime.ts'
import { detectCheckpointDrift, confirmUnreadable, type ConfirmedUnreadable, type DriftDetection } from './detect.ts'
import { dequeuePendingRestore, enqueuePendingRestore, listPendingRestores, type PendingRestoreRequestId } from './pending.ts'
import { checkpointsRoot, readManifest, type CheckpointManifest, type CheckpointSessionEntry } from './manifest.ts'
import { mountSessionsBackend, resolveSessionFormatVersion } from './validate.ts'
import { runValidationWorker, validateWorkerModule } from './worker.ts'
import type { SessionRefusalHit } from './refusal.ts'
import { readdir } from 'node:fs/promises'

/** Capture cancellation deadline; in-flight filesystem calls and published durability flushes finish. */
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
  list: ListLiveSessions
  dispose(): Promise<void>
}> {
  const mounted = await mountSessionsBackend(join(home, 'sessions'), installAnchor)
  return {
    acquire: member => mounted.persistence.acquireWriteLease(member.header),
    list: mounted.listSessions,
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
      listLiveSessions: leases.list,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.log === undefined ? {} : { log: options.log }),
    })
  } finally {
    await leases.dispose()
  }
}

/**
 * Restore one session plus its related-source closure from a specified checkpoint,
 * or the newest verified copy when no checkpoint id is supplied. Runs in a Host-down window; the caller supplies the
 * local-Host guard.
 */
export async function restoreCheckpointSession(options: {
  readonly home: string
  readonly sessionId: string
  readonly checkpointId?: string | undefined
  readonly pendingRequestId?: PendingRestoreRequestId | undefined
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
      ...(options.pendingRequestId === undefined ? {} : { pendingRequestId: options.pendingRequestId }),
      ...(options.hostRunning === undefined ? {} : { hostRunning: options.hostRunning }),
      acquireLease: leases.acquire,
      listLiveSessions: leases.list,
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
 * the caller; unfinished journals must pass the startup gate before Host launch.
 */
export async function consumePendingSessionRestores(
  options: DesktopSessionMaintenanceOptions,
): Promise<PendingRestoreResult[]> {
  const results: PendingRestoreResult[] = []
  for (const request of await listPendingRestores(options.home)) {
    let journalOwnsRequest = false
    for (const path of await listRestoreJournals(options.home)) {
      const journal = await readRestoreJournal(path)
      if (journal === undefined || journal.pendingRequestId === request.id) journalOwnsRequest = true
    }
    if (journalOwnsRequest) continue
    const outcome: RestoreOutcome = request.checkpointId === undefined
      ? { kind: 'refused', reason: { key: 'no-checkpoint' } }
      : await restoreCheckpointSession({
        ...restoreOptions(options, request.sessionId), checkpointId: request.checkpointId, pendingRequestId: request.id,
      })
    // Successful journals acknowledge their request before deletion. Refusals
    // and failures have no completed switch to replay, so consume them here.
    await dequeuePendingRestore(options.home, request.sessionId, request.id)
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
 * Candidate write leases, including related sources, are held throughout the
 * read so a concurrent append or rollback cannot produce a stale refusal.
 */
export async function detectUnreadableSessions(
  options: DesktopSessionMaintenanceOptions,
): Promise<{ manifest: CheckpointManifest; unreadable: readonly ConfirmedUnreadable[] } | undefined> {
  const anchor = resolveDshInstallAnchor(options.appPath)
  const signal = AbortSignal.timeout(DETECTION_BUDGET_MS)
  const formatVersion = await resolveSessionFormatVersion(anchor).catch(() => undefined)
  const detection = await detectCheckpointDrift(options.home, { formatVersion, signal })
  if (detection === undefined) return undefined
  if (detection.candidates.length === 0) return { manifest: detection.manifest, unreadable: [] }
  options.log?.(`drift detected against checkpoint ${detection.checkpointId}: ${detection.candidates.map(c => c.dir).join(', ')}`)
  const workerModule = validateWorkerModule(options.appPath)
  const leases = await backendLeaseAcquirer(options.home, anchor)
  try {
    const unreadable = await confirmIdleSessions(detection, leases.acquire, () => runValidationWorker(
      workerModule, join(options.home, 'sessions'), anchor, options.hostRuntime,
      signal,
    ), options.log)
    return { manifest: detection.manifest, unreadable }
  } finally {
    await leases.dispose()
  }
}

/**
 * Validate candidate sessions while their entire stored related-source closure
 * holds write leases. Contention or missing headers omit that candidate.
 * @param detection - Drift candidates and the checkpoint's related-source metadata.
 * @param acquireLease - Backend write-lease provider.
 * @param validate - Read-only live validation, invoked while all acquired leases are held.
 * @param log - Optional diagnostic sink for skipped candidates.
 * @returns Candidates still unreadable in the leased read.
 */
export async function confirmIdleSessions(
  detection: DriftDetection,
  acquireLease: AcquireSessionLease,
  validate: () => Promise<CheckpointValidationReport>,
  log?: (message: string) => void,
): Promise<readonly ConfirmedUnreadable[]> {
  const held = new Map<string, Awaited<ReturnType<AcquireSessionLease>>>()
  const eligible = new Set<string>()
  try {
    for (const item of detection.candidates) {
      const members = resolveRestoreClosure(detection.manifest, item.sessionId)
      if (members === undefined) continue
      const acquired: string[] = []
      try {
        for (const member of members) {
          if (held.has(member.dir)) continue
          const header = member.header
          if (header === undefined) throw new Error('checkpoint has no stored header')
          held.set(member.dir, await acquireLease({ sessionId: member.sessionId, dir: member.dir, header }))
          acquired.push(member.dir)
        }
        eligible.add(item.dir)
      } catch (error) {
        for (const dir of acquired) {
          await held.get(dir)?.release()
          held.delete(dir)
        }
        log?.(`drift candidate ${item.dir} skipped: cannot hold related write leases (${(error as Error).message})`)
      }
    }
    if (eligible.size === 0) return []
    return confirmUnreadable(detection, await validate()).filter(item => eligible.has(item.dir))
  } finally {
    const released = await Promise.allSettled([...held.values()].map(lease => lease.release()))
    const failed = released.filter(result => result.status === 'rejected').map((result) => {
      const reason: unknown = result.reason
      return reason
    })
    if (failed.length > 0) throw new AggregateError(failed, 'session detection lease release failed')
  }
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

/**
 * Record a confirmed restore target for the next launch's pre-Host window.
 * @param home - Active Harness home.
 * @param sessionId - Session the user confirmed restoring.
 * @param checkpointId - Checkpoint shown in that confirmation.
 * @returns Resolves after the request is durably written.
 */
export async function queueSessionRestore(home: string, sessionId: string, checkpointId: string): Promise<void> {
  await enqueuePendingRestore(home, sessionId, checkpointId)
}
