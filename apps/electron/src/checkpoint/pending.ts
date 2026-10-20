/**
 * Pending restore requests (`$DSH_HOME/electron/pending-restore.json`).
 * A restore confirmed while the local Host is up cannot run in place — the
 * entry refuses a live Host — so the confirmed intent is recorded here and
 * consumed on the next launch, inside the same pre-Host window where restore
 * journals converge. Each request is dequeued only after its restore attempt
 * resolves. A successful journal acknowledges its operation id durably
 * before deletion; a restart resumes that journal instead of repeating the
 * rollback. Requests not yet owned by a journal remain queued.
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeDesktopFileAtomic, withDesktopFileWriter } from '../atomic-file.ts'
import { createDurableDirectory, syncDirectory } from './files.ts'

/** Identity shared by one queued restore and its durable journal. */
export type PendingRestoreRequestId = Branded<'ElectronPendingRestoreRequestId'>

export interface PendingRestoreRequest {
  /** Stable operation identity, carried into its restore journal. */
  readonly id: PendingRestoreRequestId
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
    const entries = requests.filter(
      (entry): entry is Omit<PendingRestoreRequest, 'id'> & { readonly id?: string } =>
        typeof entry === 'object' && entry !== null
        && ((entry as { id?: unknown }).id === undefined || typeof (entry as { id?: unknown }).id === 'string')
        && typeof (entry as { sessionId?: unknown }).sessionId === 'string'
        && typeof (entry as { requestedAt?: unknown }).requestedAt === 'number'
        && ((entry as { checkpointId?: unknown }).checkpointId === undefined
          || typeof (entry as { checkpointId?: unknown }).checkpointId === 'string'),
    )
    return {
      version: 1,
      requests: entries.map(entry => ({
        ...entry,
        // Legacy queue entries have no id; their immutable request fields
        // supply the same identity across restarts until acknowledged.
        id: brandString<PendingRestoreRequestId>(entry.id ?? createHash('sha256')
          .update(JSON.stringify([entry.sessionId, entry.checkpointId, entry.requestedAt])).digest('hex')),
      })),
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
      { id: brandString<PendingRestoreRequestId>(randomUUID()), sessionId, checkpointId, requestedAt: Date.now() },
    ]
    await createDurableDirectory(join(home, 'electron'), home)
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
 * Acknowledge a request durably, preserving any newer request for the same session.
 * @param home - Active Harness home.
 * @param sessionId - Session whose request resolved.
 * @param requestId - Exact operation to acknowledge; omit to remove all requests for the session.
 * @returns Resolves once the queue update or removal is durable.
 */
export async function dequeuePendingRestore(home: string, sessionId: string, requestId?: PendingRestoreRequestId): Promise<void> {
  const path = pendingRestorePath(home)
  await withDesktopFileWriter(path, async () => {
    const current = (await readPendingRestores(home)).requests
    const requests = current.filter(request =>
      request.sessionId !== sessionId || (requestId !== undefined && request.id !== requestId))
    await createDurableDirectory(join(home, 'electron'), home)
    if (requests.length === current.length) return
    if (requests.length === 0) {
      await rm(path, { force: true })
      await syncDirectory(join(home, 'electron'))
      return
    }
    await writeDesktopFileAtomic(path, `${JSON.stringify({ version: 1, requests }, undefined, 2)}\n`)
  })
}
