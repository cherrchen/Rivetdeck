/**
 * Checkpoint promotion predicate (docs/electron/session-checkpoint-restore.md).
 * A shutdown report is promotable only when the Host and Main sections
 * describe the same run — identical child pid — and both record a clean
 * outcome. Any missing section, pid mismatch, timeout, kill, or nonzero exit
 * refuses promotion.
 *
 * The binding is the pid alone, not a run token: a stale report could pass
 * only if the OS recycled the exact pid of a run that had already written a
 * promotable report. That residue is accepted — capture validates every file
 * through the read path before commit, so a misattributed report cannot
 * promote unverified bytes.
 */

import type { ShutdownReport } from '../harness/shutdown-report.ts'

/**
 * Whether a shutdown report authorizes checkpoint capture. Doubles as a type
 * guard: a promotable report always carries complete Host and Main sections.
 * @param report - Merged report; sections may be absent.
 * @param childPid - Pid of the child Main just drained; binds the report to this run.
 * @returns True only when both sections describe a clean drain of this child.
 */
export function isPromotableReport(
  report: Partial<ShutdownReport>, childPid: number,
): report is ShutdownReport {
  const { host, main } = report
  if (report.version !== 1 || typeof report.recordedAt !== 'number' || host === undefined || main === undefined) {
    return false
  }
  if (main.pid !== childPid || host.pid !== main.pid) return false
  return host.reachedReady
    && host.dispose === 'clean'
    && host.exitCode === 0
    && !main.timeout
    && !main.kill
    && main.exitCode === 0
    && main.signalCode === null
}
