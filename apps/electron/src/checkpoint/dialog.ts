/**
 * Session-restore confirmation copy (docs/electron/session-checkpoint-restore.md).
 * The confirmation names the checkpoint time, the data range that becomes
 * hidden, the quarantine location, the no-other-instance precondition, and
 * the restore scope limits. All text is locale-owned through
 * `DesktopMainMessages`; this module only assembles dialog options.
 */

import { formatDesktopMessage, type DesktopMainMessages } from '../locale.ts'
import type { RestoreRefusal } from './restore.ts'

function assertNever(value: never): never {
  throw new Error(`unexpected restore refusal ${String(value)}`)
}

/** Facts one restore confirmation presents. */
export interface RestoreDialogFacts {
  readonly sessionId: string
  /** Session-local capture time — honest even when the checkpoint mixes exits. */
  readonly capturedAt: number
  /** Related-source members the transaction restores with the target. */
  readonly memberCount: number
  /** Absolute quarantine directory the replaced live files move to. */
  readonly quarantine: string
  /** The local Host is running, so restore happens through a relaunch. */
  readonly requiresRelaunch: boolean
  /** Application product name for `{name}` placeholders. */
  readonly productName: string
}

/** Locale-shaped message box description consumed by `dialog.showMessageBox`. */
export interface RestoreDialogOptions {
  readonly type: 'warning' | 'info' | 'error'
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly buttons: readonly string[]
  readonly defaultId: number
  readonly cancelId: number
}

function timestampLabel(capturedAt: number, localeId: string): string {
  return new Date(capturedAt).toLocaleString(localeId === 'zh-CN' ? 'zh-CN' : 'en-US')
}

/**
 * Build the restore-confirmation dialog. Button 0 is always the destructive
 * action (`Restore Now` when the Host is down, `Restore and Relaunch` when a
 * relaunch must reach the pre-Host window first); button 1 dismisses.
 */
export function buildRestoreConfirm(
  messages: DesktopMainMessages,
  localeId: string,
  facts: RestoreDialogFacts,
): RestoreDialogOptions {
  const time = timestampLabel(facts.capturedAt, localeId)
  const closure = facts.memberCount > 1
    ? formatDesktopMessage(messages.sessionRestoreClosure, { members: facts.memberCount })
    : ''
  const detail = formatDesktopMessage(messages.sessionRestoreDetail, {
    time,
    closure,
    quarantine: facts.quarantine,
  })
  return {
    type: 'warning',
    title: messages.sessionRestoreTitle,
    message: formatDesktopMessage(messages.sessionRestoreBody, { id: facts.sessionId, time, name: facts.productName }),
    detail,
    buttons: [
      facts.requiresRelaunch ? messages.sessionRestoreRelaunch : messages.sessionRestoreNow,
      messages.sessionRestoreLater,
    ],
    defaultId: 0,
    cancelId: 1,
  }
}

/** The "no verified copy" notice — the honest refusal surface (acceptance 10). */
export function buildNoCheckpointNotice(
  messages: DesktopMainMessages,
  sessionId: string,
): RestoreDialogOptions {
  return {
    type: 'info',
    title: messages.sessionRestoreNoCheckpointTitle,
    message: formatDesktopMessage(messages.sessionRestoreNoCheckpointBody, { id: sessionId }),
    detail: '',
    buttons: [messages.updateLater],
    defaultId: 0,
    cancelId: 0,
  }
}

/**
 * Render one typed restore refusal through the Main dictionary. The restore
 * implementation returns the key plus substitutions; product copy lives here.
 */
export function formatRestoreRefusal(messages: DesktopMainMessages, refusal: RestoreRefusal): string {
  switch (refusal.key) {
    case 'host-running': return messages.sessionRestoreRefuseHostRunning
    case 'no-checkpoint': return messages.sessionRestoreRefuseNoCheckpoint
    case 'incomplete-headers': return messages.sessionRestoreRefuseHeaders
    case 'revalidation-failed':
      return formatDesktopMessage(messages.sessionRestoreRefuseValidation, { dirs: refusal.dirs.join(', ') })
    case 'lease-held':
      return formatDesktopMessage(messages.sessionRestoreRefuseLease, { detail: refusal.detail })
    default: return assertNever(refusal)
  }
}

/**
 * Startup gate for restore journals convergence could not finish. Button 0
 * retries convergence, button 1 boots with the journals still pending, button
 * 2 quits — cancel resolves to quit so dismissing never boots silently over
 * an unrecovered transaction.
 */
export function buildDeferredJournalsGate(
  messages: DesktopMainMessages,
  journalCount: number,
): RestoreDialogOptions {
  return {
    type: 'warning',
    title: messages.sessionRestoreDeferredTitle,
    message: formatDesktopMessage(messages.sessionRestoreDeferredBody, { count: journalCount }),
    detail: messages.sessionRestoreDeferredDetail,
    buttons: [
      messages.sessionRestoreDeferredRetry,
      messages.sessionRestoreDeferredContinue,
      messages.menuQuit,
    ],
    defaultId: 0,
    cancelId: 2,
  }
}

/**
 * Startup gate for an intent journal whose checkpoint is gone — the
 * interrupted switch can never finish. Button 0 abandons the restore record,
 * button 1 keeps it pending for the next launch, button 2 quits; keeping is
 * the default so a stray Enter never discards the recovery record.
 */
export function buildOrphanedJournalGate(
  messages: DesktopMainMessages,
  facts: { readonly checkpointId: string; readonly quarantine: string },
): RestoreDialogOptions {
  return {
    type: 'warning',
    title: messages.sessionRestoreOrphanTitle,
    message: formatDesktopMessage(messages.sessionRestoreOrphanBody, { checkpoint: facts.checkpointId }),
    detail: formatDesktopMessage(messages.sessionRestoreOrphanDetail, { quarantine: facts.quarantine }),
    buttons: [
      messages.sessionRestoreOrphanAbandon,
      messages.sessionRestoreOrphanKeep,
      messages.menuQuit,
    ],
    defaultId: 1,
    cancelId: 2,
  }
}

/** Post-restore outcome or manual-scan notice: one dismiss-only info dialog. */
export function buildRestoreNotice(
  messages: DesktopMainMessages,
  title: string,
  body: string,
): RestoreDialogOptions {
  return {
    type: 'info',
    title,
    message: body,
    detail: '',
    buttons: [messages.updateLater],
    defaultId: 0,
    cancelId: 0,
  }
}

/** Short session label for notices: the raw id, or the encoded dir tail when only that is known. */
export function refusalLabel(sessionId: string | undefined, dirTail: string | undefined): string {
  return sessionId ?? dirTail ?? '?'
}
