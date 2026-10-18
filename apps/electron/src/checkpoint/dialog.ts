/**
 * Session-restore confirmation copy (docs/electron/session-checkpoint-restore.md).
 * The confirmation names the checkpoint time, the data range that becomes
 * hidden, the quarantine location, the no-other-instance precondition, and
 * the restore scope limits. All text is locale-owned through
 * `DesktopMainMessages`; this module only assembles dialog options.
 */

import { formatDesktopMessage, type DesktopMainMessages } from '../locale.ts'

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
