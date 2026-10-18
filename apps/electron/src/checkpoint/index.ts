/**
 * Exit-checkpoint orchestration entry for `main.ts`. Runs after a promotable
 * drain inside `prepareToInstall`, bounded by a deadline so quitting cannot
 * hang on capture; an aborted attempt discards the `.tmp` candidate and never
 * blocks or fails the exit path.
 */

import { join } from 'node:path'
import { runExitCheckpoint, type ExitCheckpointOutcome } from './capture.ts'
import { listRestoreJournals } from './journal.ts'
import { convergeRestoreJournals, restoreSession, type AcquireSessionLease, type RestoreOutcome } from './restore.ts'
import { resolveDshInstallAnchor, resolveHostRuntime, type HostRuntime } from '../runtime.ts'
import { mountSessionsBackend } from './validate.ts'
import { runValidationWorker, validateWorkerModule } from './worker.ts'

/** Total wall-clock budget for one exit capture; the deadline kills the validation worker. */
export const CHECKPOINT_CAPTURE_BUDGET_MS = 120_000

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
 * fast path returns without loading the backend; convergence failures are
 * logged and never block startup.
 */
export async function convergeDesktopRestoreJournals(options: {
  readonly home: string
  readonly appPath: string
  readonly signal?: AbortSignal | undefined
  readonly log?: ((message: string) => void) | undefined
}): Promise<{ converged: string[]; conflicted: string[]; deferred: string[] }> {
  if ((await listRestoreJournals(options.home)).length === 0) {
    return { converged: [], conflicted: [], deferred: [] }
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
