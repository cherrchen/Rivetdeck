/**
 * Restore journal (docs/electron/session-checkpoint-restore.md).
 * One restore transaction persists `intent → committed → finalized` under
 * `$DSH_HOME/electron/restore-journals/`; a leftover journal is converged
 * before the next Host spawn. `intent` fingerprints the live files so a
 * resume detects foreign writes instead of overwriting them; `committed`
 * marks the point past which the file switch is never re-applied; the
 * journal is deleted only after finalize is durable.
 */

import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeDesktopFileAtomic } from '../atomic-file.ts'
import type { CheckpointDigest, CheckpointSessionHeader } from './manifest.ts'

export type RestoreJournalPhase = 'intent' | 'committed' | 'finalized' | 'conflicted'

/** Live-file stat recorded at intent time; a resume refuses to overwrite drift. */
export interface RestoreFingerprint {
  /** Filename relative to the member session dir (never a nested path). */
  readonly name: string
  readonly size: number
  readonly mtimeNs: string
}

/** One checkpoint file the transaction publishes under its canonical name. */
export interface RestorePublish {
  /** Canonical filename inside the member dir, e.g. `session.v4.jsonl.zstd`. */
  readonly name: string
  /** Integrity of the staged bytes; re-verified on resume so a torn or replaced temp is re-staged, never published. */
  readonly digest: CheckpointDigest
}

/** One session directory the transaction replaces: the target plus its related-source closure. */
export interface RestoreJournalMember {
  readonly sessionId: string
  /** Session dir relative to `sessions/`, POSIX separators (`<project-key>/<encoded-id>`). */
  readonly dir: string
  /** Stored session header; re-acquires `session.lock` through the backend seam on resume. */
  readonly header: CheckpointSessionHeader
  /** Live canonical files fingerprinted at intent (relative names inside the member dir). */
  readonly liveFiles: readonly RestoreFingerprint[]
  /** Checkpoint files staged then published (relative names inside the member dir). */
  readonly publish: readonly RestorePublish[]
}

export interface RestoreJournal {
  readonly version: 1
  /** Journal id; also names the quarantine directory. */
  readonly id: string
  readonly phase: RestoreJournalPhase
  readonly checkpointId: string
  readonly targetSessionId: string
  readonly createdAt: number
  readonly updatedAt: number
  /** `$DSH_HOME`-relative quarantine directory (`electron/quarantine/<id>`). */
  readonly quarantine: string
  /** Which live path drifted when `phase` is `conflicted`. */
  readonly conflict?: string
  readonly members: readonly RestoreJournalMember[]
}

/** Directory holding in-flight restore journals. */
export function restoreJournalsDir(home: string): string {
  return join(home, 'electron', 'restore-journals')
}

/** Quarantine root for moved-aside live files of one restore. */
export function restoreQuarantineDir(home: string, journalId: string): string {
  return join(home, 'electron', 'quarantine', journalId)
}

/** Persist the journal durably (tmp + fsync + rename + directory fsync). */
export async function writeRestoreJournal(home: string, journal: RestoreJournal): Promise<void> {
  const path = join(restoreJournalsDir(home), `${journal.id}.json`)
  await writeDesktopFileAtomic(path, `${JSON.stringify(journal, undefined, 2)}\n`)
}

/** Delete the journal after a durable `finalized` record; idempotent. */
export async function deleteRestoreJournal(home: string, id: string): Promise<void> {
  await rm(join(restoreJournalsDir(home), `${id}.json`), { force: true })
}

/** Read one journal, tolerating absence and malformed content. */
export async function readRestoreJournal(path: string): Promise<RestoreJournal | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as { readonly version?: unknown; readonly phase?: unknown }
  if (record.version !== 1) return undefined
  if (record.phase !== 'intent' && record.phase !== 'committed'
    && record.phase !== 'finalized' && record.phase !== 'conflicted') return undefined
  return parsed as RestoreJournal
}

/** List persisted journals (absolute paths), oldest id first. */
export async function listRestoreJournals(home: string): Promise<string[]> {
  const dir = restoreJournalsDir(home)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => join(dir, name))
}
