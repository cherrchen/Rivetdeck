/**
 * Exit-checkpoint orchestration entry for `main.ts`. Runs after a promotable
 * drain inside `prepareToInstall`, bounded by a deadline so quitting cannot
 * hang on capture; an aborted attempt discards the `.tmp` candidate and never
 * blocks or fails the exit path.
 */

import { runExitCheckpoint, type ExitCheckpointOutcome } from './capture.ts'
import { resolveDshInstallAnchor, resolveHostRuntime, type HostRuntime } from '../runtime.ts'
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
