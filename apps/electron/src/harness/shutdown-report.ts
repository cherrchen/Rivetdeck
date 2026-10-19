/**
 * Desktop Host shutdown report (docs/electron/session-checkpoint-restore.md).
 * The Host persists its own drain outcome synchronously before exit; Main
 * merges supervision facts after observing the child exit. A missing or
 * partial report is never promotable: checkpoint promotion requires the Host
 * section to record a reached-ready, cleanly drained run AND the Main section
 * to record a signal-free clean exit.
 */

import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withDesktopFileWriter, writeDesktopFileAtomic } from '../atomic-file.ts'

/** Report file location under the Desktop-private `$DSH_HOME/electron/` state directory. */
export function shutdownReportPath(home: string): string {
  return join(home, 'electron', 'shutdown-report.json')
}

/** Channel that requested the Host shutdown. */
export type ShutdownRequestCause = 'SIGTERM' | 'SIGINT' | 'cli' | 'ipc'

/**
 * Drain/dispose outcome the Host observed about itself.
 * - `clean`: disposal settled inside the shutdown window.
 * - `failed`: disposal rejected.
 * - `timeout`: disposal did not settle before `PROCESS_SHUTDOWN_TIMEOUT_MS`.
 * - `interrupted`: a second signal forced exit while disposal was in flight.
 */
export type HostDisposeOutcome = 'clean' | 'failed' | 'timeout' | 'interrupted'

/** Facts the Host owns about its own shutdown. */
export interface HostShutdownSection {
  /** Host process id; lets Main detect a report left by a different run. */
  readonly pid: number
  /** The Web composition reached readiness during this run. */
  readonly reachedReady: boolean
  /** First shutdown request observed; absent when the run died before one. */
  readonly requestedBy: ShutdownRequestCause | null
  /** Drain/dispose outcome; promotion accepts only `clean`. */
  readonly dispose: HostDisposeOutcome
  /** Exit code the Host intended for itself; null when the run never decided. */
  readonly exitCode: number | null
}

/** Facts Main owns about the supervised child exit. */
export interface MainShutdownSection {
  /** Child pid the observation describes. */
  readonly pid: number
  /** First signal Main delivered; null for IPC requests or an already exited child. */
  readonly signal: NodeJS.Signals | null
  /** The cooperative shutdown grace period elapsed before the exit event. */
  readonly timeout: boolean
  /** SIGKILL was delivered. */
  readonly kill: boolean
  /** Exit code observed on the child `exit` event; null on signal exit. */
  readonly exitCode: number | null
  /** Exit signal observed on the child `exit` event; null on coded exit. */
  readonly signalCode: NodeJS.Signals | null
}

/**
 * On-disk shutdown report. `host` is absent when the Host never controlled an
 * exit path (early crash, SIGKILL, or boot failure before the controller ran);
 * `main` is absent until Main merges its observation.
 */
export interface ShutdownReport {
  readonly version: 1
  /** Epoch milliseconds of the last section write. */
  readonly recordedAt: number
  readonly host?: HostShutdownSection
  readonly main?: MainShutdownSection
}

function serializeReport(report: ShutdownReport): string {
  return `${JSON.stringify(report, undefined, 2)}\n`
}

/**
 * Persist the Host section atomically and synchronously so even a forced exit
 * leaves a durable report. Tmp sibling + fsync + rename + directory fsync,
 * mirroring {@link writeDesktopFileAtomic}.
 * @param home - `$DSH_HOME` the report lives under.
 * @param host - Host-owned shutdown facts.
 */
export function writeShutdownReportSync(home: string, host: HostShutdownSection): void {
  const path = shutdownReportPath(home)
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, serializeReport({ version: 1, recordedAt: Date.now(), host }))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  if (process.platform !== 'win32') {
    const directoryFd = openSync(directory, 'r')
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
  }
}

/**
 * Merge Main's supervision facts into the shutdown report after the child
 * exits. The Host and Main write in strict sequence (Host before exit, Main
 * after exit); the per-path write queue covers repeated observations of the
 * same child, which merge by taking the strongest recorded facts. A report
 * from a different child pid is replaced wholesale.
 * @param home - `$DSH_HOME` the report lives under.
 * @param facts - Main-owned supervision facts.
 */
export async function mergeMainShutdownFacts(home: string, facts: MainShutdownSection): Promise<void> {
  const path = shutdownReportPath(home)
  await withDesktopFileWriter(path, async () => {
    const existing = await readShutdownReport(path)
    const report: ShutdownReport = {
      version: 1,
      recordedAt: Date.now(),
      ...(existing.host === undefined ? {} : { host: existing.host }),
      main: mergeMainSections(existing.main, facts),
    }
    await writeDesktopFileAtomic(path, serializeReport(report))
  })
}

function mergeMainSections(previous: MainShutdownSection | undefined, facts: MainShutdownSection): MainShutdownSection {
  if (previous === undefined || previous.pid !== facts.pid) return facts
  return {
    pid: facts.pid,
    signal: facts.signal ?? previous.signal,
    timeout: previous.timeout || facts.timeout,
    kill: previous.kill || facts.kill,
    // The exit event fires once; the first observation owns the exit fields.
    exitCode: previous.exitCode,
    signalCode: previous.signalCode,
  }
}

/**
 * Read the persisted shutdown report for one Harness home.
 * @param home - `$DSH_HOME` the report lives under.
 * @returns The stored sections, or none when the file is absent or unreadable.
 */
export async function readShutdownReportFile(home: string): Promise<Partial<ShutdownReport>> {
  return readShutdownReport(shutdownReportPath(home))
}

/**
 * Read a persisted report, tolerating a missing or unreadable file.
 * @param path - Report path.
 * @returns The stored sections, or none when the file is absent or not a report.
 */
async function readShutdownReport(path: string): Promise<Partial<ShutdownReport>> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code !== 'ENOENT') {
      console.error(`desktop shutdown report: cannot read ${path}`, error)
    }
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.error(`desktop shutdown report: malformed JSON in ${path}`, error)
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const record = parsed as {
    readonly version?: unknown
    readonly recordedAt?: unknown
    readonly host?: unknown
    readonly main?: unknown
  }
  if (record.version !== 1) return {}
  return {
    version: 1,
    ...(typeof record.recordedAt === 'number' ? { recordedAt: record.recordedAt } : {}),
    ...(typeof record.host === 'object' && record.host !== null ? { host: record.host as HostShutdownSection } : {}),
    ...(typeof record.main === 'object' && record.main !== null ? { main: record.main as MainShutdownSection } : {}),
  }
}
