/**
 * Pending restore requests (`$DSH_HOME/electron/pending-restore.json`).
 * A restore confirmed while the local Host is up cannot run in place — the
 * entry refuses a live Host — so the confirmed intent is recorded here and
 * consumed on the next launch, inside the same pre-Host window where restore
 * journals converge. Consuming deletes the file once the transaction begins;
 * the journal is the durable record past that point.
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeDesktopFileAtomic, withDesktopFileWriter } from '../atomic-file.ts'

export interface PendingRestoreRequest {
  readonly sessionId: string
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
          && typeof (entry as { requestedAt?: unknown }).requestedAt === 'number',
      ),
    }
  } catch {
    return { version: 1, requests: [] }
  }
}

/**
 * Record a confirmed restore intent for the next launch. Duplicate session
 * entries collapse to the newest request.
 */
export async function enqueuePendingRestore(home: string, sessionId: string): Promise<void> {
  const path = pendingRestorePath(home)
  await withDesktopFileWriter(path, async () => {
    const current = await readPendingRestores(home)
    const requests = [
      ...current.requests.filter(request => request.sessionId !== sessionId),
      { sessionId, requestedAt: Date.now() },
    ]
    await writeDesktopFileAtomic(path, `${JSON.stringify({ version: 1, requests }, undefined, 2)}\n`)
  })
}

/**
 * Read every queued request and delete the file before any restore runs; a
 * crash after consumption is covered by the restore journal itself.
 */
export async function consumePendingRestores(home: string): Promise<readonly PendingRestoreRequest[]> {
  const pending = await readPendingRestores(home)
  if (pending.requests.length === 0) return []
  await rm(pendingRestorePath(home), { force: true })
  return pending.requests
}
