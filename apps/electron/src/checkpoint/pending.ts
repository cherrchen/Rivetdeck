/**
 * Pending restore requests (`$DSH_HOME/electron/pending-restore.json`).
 * A restore confirmed while the local Host is up cannot run in place — the
 * entry refuses a live Host — so the confirmed intent is recorded here and
 * consumed on the next launch, inside the same pre-Host window where restore
 * journals converge. Each request is dequeued only after its restore attempt
 * resolves, so a crash mid-queue leaves the unprocessed remainder durable;
 * the journal is the durable record once a transaction begins.
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeDesktopFileAtomic, withDesktopFileWriter } from '../atomic-file.ts'

export interface PendingRestoreRequest {
  readonly sessionId: string
  /** Absent only on legacy requests, which must be refused rather than retargeted. */
  readonly checkpointId?: string
  readonly requestedAt: number
}

interface PendingRestores {
  readonly version: 1
  readonly requests: readonly PendingRestoreRequest[]
}

function pendingRestorePath(home: string): string {
  return join(home, 'electron', 'pending-restore.json')
}

async function readPendingRestores(home: string): Promise<PendingRestores> {
  let raw: string
  try {
    raw = await readFile(pendingRestorePath(home), 'utf8')
  } catch {
    return { version: 1, requests: [] }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, requests: [] }
    const requests = (parsed as { requests?: unknown }).requests
    if (!Array.isArray(requests)) return { version: 1, requests: [] }
    return {
      version: 1,
      requests: requests.filter(
        (entry): entry is PendingRestoreRequest =>
          typeof entry === 'object' && entry !== null
          && typeof (entry as { sessionId?: unknown }).sessionId === 'string'
          && typeof (entry as { requestedAt?: unknown }).requestedAt === 'number'
          && ((entry as { checkpointId?: unknown }).checkpointId === undefined
            || typeof (entry as { checkpointId?: unknown }).checkpointId === 'string'),
      ),
    }
  } catch {
    return { version: 1, requests: [] }
  }
}

/**
 * Record a confirmed restore intent for the next launch. Duplicate session
 * entries collapse to the newest request; the checkpoint never changes implicitly.
 * @param home - Active Harness home.
 * @param sessionId - Session the user confirmed restoring.
 * @param checkpointId - Checkpoint shown in that confirmation.
 * @returns Resolves after the request is durably written.
 */
export async function enqueuePendingRestore(home: string, sessionId: string, checkpointId: string): Promise<void> {
  const path = pendingRestorePath(home)
  await withDesktopFileWriter(path, async () => {
    const current = await readPendingRestores(home)
    const requests = [
      ...current.requests.filter(request => request.sessionId !== sessionId),
      { sessionId, checkpointId, requestedAt: Date.now() },
    ]
    await writeDesktopFileAtomic(path, `${JSON.stringify({ version: 1, requests }, undefined, 2)}\n`)
  })
}

/**
 * Read every queued request without removing it. Entries stay durable until
 * {@link dequeuePendingRestore} runs, which callers do once that request's
 * restore attempt has resolved — so an interruption mid-queue re-presents the
 * unprocessed remainder on the next launch.
 */
export async function listPendingRestores(home: string): Promise<readonly PendingRestoreRequest[]> {
  return (await readPendingRestores(home)).requests
}

/**
 * Remove one request after its restore attempt resolved. The rewrite goes
 * through the desktop writer lock, so a request enqueued between list and
 * dequeue is preserved.
 */
export async function dequeuePendingRestore(home: string, sessionId: string): Promise<void> {
  const path = pendingRestorePath(home)
  await withDesktopFileWriter(path, async () => {
    const requests = (await readPendingRestores(home)).requests
      .filter(request => request.sessionId !== sessionId)
    if (requests.length === 0) {
      await rm(path, { force: true })
      return
    }
    await writeDesktopFileAtomic(path, `${JSON.stringify({ version: 1, requests }, undefined, 2)}\n`)
  })
}
