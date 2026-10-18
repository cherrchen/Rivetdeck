/**
 * Journaled per-session restore (docs/electron/session-checkpoint-restore.md).
 * The transaction runs inside the target session's `session.lock` write
 * lease — a successful acquire proves no live writer — and every step is
 * idempotent so a leftover journal converges on the next startup, before
 * the Host spawns. Live files are fingerprinted at intent and moved to a
 * quarantine directory inside the kept session directory's parent tree;
 * checkpoint bytes publish under canonical names that readers always
 * observe complete or absent. `committed` journals never re-apply the
 * switch; they still run finalize (projcache invalidation) before the
 * journal is deleted.
 */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, copyFile, mkdir, open, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { renameDesktopPath } from '../atomic-file.ts'
import { checkpointsRoot, readManifest, type CheckpointManifest, type CheckpointSessionEntry } from './manifest.ts'
import {
  deleteRestoreJournal,
  listRestoreJournals,
  readRestoreJournal,
  restoreJournalsDir,
  writeRestoreJournal,
  type RestoreFingerprint,
  type RestoreJournal,
  type RestoreJournalMember,
  type RestorePublish,
} from './journal.ts'
import type { ValidateSessions } from './capture.ts'

/** Held `session.lock` write lease; released by closing it. */
export interface SessionLease {
  release(): Promise<void>
}

/** Lease provider: production resolves the backend seam; tests inject fakes. */
export type AcquireSessionLease = (member: RestoreJournalMember) => Promise<SessionLease>

/** Staged replacement name inside the member dir, next to the canonical file. */
function stagedName(canonical: string): string {
  return `${canonical}.restore.tmp`
}

/** True for session-generation files a restore owns inside a member dir. */
function isOwnedSessionFile(name: string): boolean {
  if (name === 'session.lock') return false
  if (name.endsWith('.tmp')) return false
  return /^session(?:\.v\d+)?\.jsonl(?:\.\w+)?$/.test(name)
}

/** Absolute member directory for a `sessions/`-relative journal dir. */
function memberDir(home: string, dir: string): string {
  return join(home, 'sessions', ...dir.split('/'))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Fsync a directory on POSIX; Windows follows the backend's write-through precedent. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** sha256 of a file's current bytes. */
async function digestFile(path: string): Promise<{ size: number; sha256: string }> {
  const buffer = await readFile(path)
  return { size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }
}

/**
 * Move `source` to `destination` atomically; cross-device homes fall back to
 * copy-verify-unlink (resume dedups because the source disappears only after
 * the verified destination exists).
 */
async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await renameDesktopPath(source, destination)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EXDEV') throw error
  }
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  await unlink(source)
}

/** Copy a checkpoint file into the member dir as a staged temporary, fsynced and digest-verified. */
async function stagePublishFile(
  checkpointDir: string,
  member: RestoreJournalMember,
  publish: RestorePublish,
  liveDir: string,
): Promise<void> {
  const source = join(checkpointDir, 'sessions', ...member.dir.split('/'), publish.name)
  const staged = join(liveDir, stagedName(publish.name))
  await copyFile(source, staged)
  const actual = await digestFile(staged)
  if (actual.sha256 !== publish.digest.sha256 || actual.size !== publish.digest.size) {
    throw new Error(`checkpoint file ${publish.name} no longer matches the manifest digest`)
  }
  const handle = await open(staged, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Fingerprinted live stat check; a mismatch means a foreign writer touched the file. */
async function fingerprintMatches(livePath: string, fingerprint: RestoreFingerprint): Promise<boolean> {
  let current
  try {
    current = await stat(livePath, { bigint: true })
  } catch {
    return false
  }
  return current.isFile()
    && Number(current.size) === fingerprint.size
    && String(current.mtimeNs) === fingerprint.mtimeNs
}

/** Error carrying the drifted live path for journal `conflict` reporting. */
class RestoreConflict extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`)
    this.name = 'RestoreConflict'
  }
}

/**
 * Apply (or finish applying) one member's switch. Idempotent per file: a
 * fingerprinted live file still in place is verified then quarantined, a
 * staged temporary is published, and an already-published canonical is
 * recognized by digest.
 * @throws {RestoreConflict} When live state no longer matches the recorded intent.
 */
async function resumeMember(
  home: string,
  checkpointDir: string,
  journal: RestoreJournal,
  member: RestoreJournalMember,
): Promise<void> {
  const liveDir = memberDir(home, member.dir)
  const quarantineMemberDir = join(home, journal.quarantine, 'sessions', ...member.dir.split('/'))
  await mkdir(liveDir, { recursive: true, mode: 0o700 })
  const fingerprints = new Map(member.liveFiles.map(entry => [entry.name, entry]))
  const publish = new Map(member.publish.map(entry => [entry.name, entry]))
  const current = (await readdir(liveDir)).filter(isOwnedSessionFile)

  // Foreign-drift pre-check: a canonical file that is neither a recorded live
  // fingerprint nor our own already-published bytes appeared after the intent
  // was journaled, or a mid-switch write landed between phases.
  for (const name of current) {
    if (fingerprints.has(name)) continue
    const plan = publish.get(name)
    if (plan !== undefined
      && (await digestFile(join(liveDir, name))).sha256 === plan.digest.sha256) continue
    throw new RestoreConflict(join(member.dir, name), 'live file appeared after the restore intent was journaled')
  }

  for (const name of new Set([...fingerprints.keys(), ...publish.keys()])) {
    const fingerprint = fingerprints.get(name)
    const plan = publish.get(name)
    const livePath = join(liveDir, name)
    const quarantinePath = join(quarantineMemberDir, name)
    const stagedPath = join(liveDir, stagedName(name))
    const liveExists = await pathExists(livePath)
    const quarantined = await pathExists(quarantinePath)

    if (fingerprint !== undefined) {
      if (liveExists && quarantined) {
        // The canonical name was re-occupied after the quarantine move: ours
        // when the digest matches, foreign otherwise.
        const republished = plan !== undefined
          && (await digestFile(livePath)).sha256 === plan.digest.sha256
        if (!republished) {
          throw new RestoreConflict(join(member.dir, name), 'live file was recreated during the interrupted restore')
        }
      } else if (liveExists) {
        if (!(await fingerprintMatches(livePath, fingerprint))) {
          throw new RestoreConflict(join(member.dir, name), 'live file changed during the interrupted restore')
        }
        await mkdir(dirname(quarantinePath), { recursive: true })
        await moveFile(livePath, quarantinePath)
      } else if (!quarantined) {
        throw new RestoreConflict(join(member.dir, name), 'live file vanished during the interrupted restore')
      }
    }

    if (plan === undefined) continue
    if (await pathExists(stagedPath)) {
      await renameDesktopPath(stagedPath, livePath)
    } else if (!(await pathExists(livePath))) {
      await stagePublishFile(checkpointDir, member, plan, liveDir)
      await renameDesktopPath(join(liveDir, stagedName(name)), livePath)
    }
    // Remaining case: canonical already holds the published bytes (verified
    // by the pre-check), or holds a fingerprinted file already quarantined —
    // which cannot reach here because the quarantine move precedes publish.
  }
  await syncDirectory(liveDir)
}

/** Stage every member's publish files, then switch member by member. */
async function applySwitch(
  home: string,
  checkpointDir: string,
  journal: RestoreJournal,
): Promise<void> {
  for (const member of journal.members) {
    const liveDir = memberDir(home, member.dir)
    for (const plan of member.publish) {
      if (await pathExists(join(liveDir, stagedName(plan.name)))) continue
      const canonical = join(liveDir, plan.name)
      if (await pathExists(canonical)
        && (await digestFile(canonical)).sha256 === plan.digest.sha256) continue
      await stagePublishFile(checkpointDir, member, plan, liveDir)
    }
  }
  for (const member of journal.members) {
    await resumeMember(home, checkpointDir, journal, member)
  }
}

/** Invalidate the projcache rows of the target and its related-source closure; idempotent. */
async function finalizeProjcache(home: string, journal: RestoreJournal): Promise<void> {
  const rowsDir = join(home, 'storages', 'session_projcache', 'sessions')
  for (const member of journal.members) {
    await rm(join(rowsDir, `${member.sessionId}.json`), { force: true })
  }
  if (await pathExists(rowsDir)) await syncDirectory(rowsDir)
}

/** Persist a phase transition durably before the work it gates proceeds. */
async function persistPhase(home: string, journal: RestoreJournal, phase: RestoreJournal['phase']): Promise<RestoreJournal> {
  const next: RestoreJournal = { ...journal, phase, updatedAt: Date.now() }
  await writeRestoreJournal(home, next)
  return next
}

/**
 * Drive a journal from its recorded phase to deletion: `intent` resumes the
 * switch, `committed` only finalizes, `finalized` only deletes the record.
 * @returns The terminal phase, or the conflict description when it stops.
 */
async function convergeJournal(
  home: string,
  checkpointDir: string,
  journal: RestoreJournal,
): Promise<RestoreJournal> {
  let current = journal
  if (current.phase === 'intent') {
    try {
      await applySwitch(home, checkpointDir, current)
    } catch (error) {
      if (!(error instanceof RestoreConflict)) throw error
      const stopped: RestoreJournal = { ...current, phase: 'conflicted', conflict: error.path, updatedAt: Date.now() }
      await writeRestoreJournal(home, stopped)
      return stopped
    }
    current = await persistPhase(home, current, 'committed')
  }
  if (current.phase === 'committed') {
    await finalizeProjcache(home, current)
    current = await persistPhase(home, current, 'finalized')
  }
  if (current.phase === 'finalized') {
    await deleteRestoreJournal(home, current.id)
    await syncDirectory(restoreJournalsDir(home)).catch(() => undefined)
  }
  return current
}

/** Compute the restore unit: the target plus its transitive subagent descendants. */
export function resolveRestoreClosure(manifest: CheckpointManifest, targetSessionId: string): CheckpointSessionEntry[] | undefined {
  const entries = manifest.sessions
  const target = entries.find(entry => entry.sessionId === targetSessionId)
  if (target === undefined) return undefined
  // A manifest without headers cannot prove parentage: the closure would be
  // silently incomplete, so the checkpoint is unrestorable.
  if (entries.some(entry => entry.header === undefined)) return undefined
  const members = new Map([[target.sessionId, target]])
  for (;;) {
    let grew = false
    for (const entry of entries) {
      if (members.has(entry.sessionId)) continue
      const parent = entry.header?.parentSession
      if (entry.header?.origin === 'subagent' && parent !== undefined && members.has(parent)) {
        members.set(entry.sessionId, entry)
        grew = true
      }
    }
    if (!grew) break
  }
  return [...members.values()]
}

/** Newest committed checkpoint whose manifest holds a verified entry for `sessionId`. */
async function findCheckpoint(
  home: string,
  sessionId: string,
  checkpointId?: string,
): Promise<{ dir: string; manifest: CheckpointManifest } | undefined> {
  const root = checkpointsRoot(home)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return undefined
  }
  const committed = names.filter(name => !name.endsWith('.tmp')).sort().reverse()
  for (const name of committed) {
    if (checkpointId !== undefined && name !== checkpointId) continue
    const dir = join(root, name)
    const manifest = await readManifest(dir)
    if (manifest !== undefined && manifest.sessions.some(entry => entry.sessionId === sessionId)) {
      return { dir, manifest }
    }
  }
  return undefined
}

export type RestoreOutcome =
  | { readonly kind: 'restored'; readonly checkpointId: string; readonly sessions: readonly string[]; readonly quarantine: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'conflicted'; readonly reason: string; readonly journalId: string }
  | { readonly kind: 'failed'; readonly reason: string }

export interface RestoreSessionOptions {
  /** `$DSH_HOME`. */
  readonly home: string
  /** Session to roll back, with its related-source closure. */
  readonly sessionId: string
  /** Pin a specific checkpoint; newest containing the session when omitted. */
  readonly checkpointId?: string
  /** Refuse while the local Host is up — restore runs in a Host-down window. */
  readonly hostRunning?: (() => boolean) | undefined
  /** `session.lock` acquisition through the backend seam. */
  readonly acquireLease: AcquireSessionLease
  /** Re-validation of the checkpoint bytes under the current build. */
  readonly validate: ValidateSessions
  readonly signal?: AbortSignal | undefined
  readonly now?: (() => number) | undefined
  readonly log?: ((message: string) => void) | undefined
}

/**
 * Restore one session (and its related-source closure) from its newest
 * verified checkpoint copy. The caller must hold the no-other-Harness
 * precondition for the whole transaction: `hostRunning` guards the local
 * Host and lease acquisition detects foreign writers; foreign readers leave
 * no trace and are excluded by the confirmed precondition, not the lease.
 */
export async function restoreSession(options: RestoreSessionOptions): Promise<RestoreOutcome> {
  const log = options.log ?? (() => undefined)
  if (options.hostRunning?.() === true) {
    return { kind: 'refused', reason: 'the local Harness Host is still running' }
  }
  const found = await findCheckpoint(options.home, options.sessionId, options.checkpointId)
  if (found === undefined) {
    return { kind: 'refused', reason: `no verified checkpoint copy exists for session ${options.sessionId}` }
  }
  const members = resolveRestoreClosure(found.manifest, options.sessionId)
  if (members === undefined) {
    return { kind: 'refused', reason: 'checkpoint does not record enough header data to derive the related-source closure' }
  }
  // Re-validate under the current build: stored verification is validator-bound
  // and does not carry across upgrades or downgrades.
  const report = await options.validate(join(found.dir, 'sessions'), options.signal)
  const invalid = members.filter(member => !report.sessions.some(result => result.dir === member.dir && result.ok))
  if (invalid.length > 0) {
    return { kind: 'refused', reason: `checkpoint copy no longer validates: ${invalid.map(member => member.dir).join(', ')}` }
  }
  const now = options.now ?? (() => Date.now())
  const journalId = `${now()}-${options.sessionId}`
  const leases: SessionLease[] = []
  const journalMembers: RestoreJournalMember[] = []
  try {
    for (const entry of members) {
      const member: RestoreJournalMember = {
        sessionId: entry.sessionId,
        dir: entry.dir,
        // relatedClosure refuses manifests without headers, so the stored
        // header is always present; it re-acquires the lease on resume.
        header: entry.header ?? { id: entry.sessionId },
        liveFiles: [],
        publish: found.manifest.files
          .filter(file => file.path.startsWith(`sessions/${entry.dir}/`))
          .map(file => ({ name: file.path.slice(`sessions/${entry.dir}/`.length), digest: file.digest })),
      }
      // Acquire before fingerprinting: the lease proves no live writer, so
      // the recorded pre-state cannot race a foreign append.
      leases.push(await options.acquireLease(member))
      const liveDir = memberDir(options.home, member.dir)
      const liveFiles: RestoreFingerprint[] = []
      try {
        for (const name of await readdir(liveDir)) {
          if (!isOwnedSessionFile(name)) continue
          const fileStat = await stat(join(liveDir, name), { bigint: true })
          liveFiles.push({ name, size: Number(fileStat.size), mtimeNs: String(fileStat.mtimeNs) })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
      }
      journalMembers.push({ ...member, liveFiles })
    }
    let journal: RestoreJournal = {
      version: 1,
      id: journalId,
      phase: 'intent',
      checkpointId: found.manifest.id,
      targetSessionId: options.sessionId,
      createdAt: now(),
      updatedAt: now(),
      quarantine: `electron/quarantine/${journalId}`,
      members: journalMembers,
    }
    journal = await persistPhase(options.home, journal, 'intent')
    try {
      journal = await convergeJournal(options.home, found.dir, journal)
    } catch (error) {
      return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
    if (journal.phase === 'conflicted') {
      return {
        kind: 'conflicted',
        reason: `live data changed during the interrupted restore (${journal.conflict ?? 'unknown path'})`,
        journalId: journal.id,
      }
    }
    log(`restored session ${options.sessionId} from checkpoint ${found.manifest.id}; live files moved to ${journal.quarantine}`)
    return { kind: 'restored', checkpointId: found.manifest.id, sessions: members.map(member => member.sessionId), quarantine: journal.quarantine }
  } catch (error) {
    if ((error as Error).name === 'SessionAlreadyOwnedError') {
      return { kind: 'refused', reason: `session write lease is held by a live writer: ${(error as Error).message}` }
    }
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    for (const lease of leases) await lease.release().catch(() => undefined)
  }
}

export interface ConvergeJournalsOptions {
  readonly home: string
  readonly acquireLease: AcquireSessionLease
  readonly log?: ((message: string) => void) | undefined
  readonly signal?: AbortSignal | undefined
}

/**
 * Converge leftover restore journals at startup, before the Host spawns.
 * The resume re-establishes the no-other-Harness precondition by
 * re-acquiring every member lease — contention means a foreign instance is
 * live, so the journal is kept for the next startup rather than applied
 * unsafely.
 */
export async function convergeRestoreJournals(
  options: ConvergeJournalsOptions,
): Promise<{ converged: string[]; conflicted: string[]; deferred: string[] }> {
  const log = options.log ?? (() => undefined)
  const converged: string[] = []
  const conflicted: string[] = []
  const deferred: string[] = []
  for (const path of await listRestoreJournals(options.home)) {
    options.signal?.throwIfAborted()
    const journal = await readRestoreJournal(path)
    if (journal === undefined) {
      log(`restore journal ${path} is unreadable; left in place`)
      continue
    }
    if (journal.phase === 'conflicted') {
      conflicted.push(journal.id)
      continue
    }
    const checkpoint = await findCheckpoint(options.home, journal.targetSessionId, journal.checkpointId)
    if (checkpoint === undefined) {
      deferred.push(journal.id)
      log(`restore journal ${journal.id}: checkpoint ${journal.checkpointId} is gone; deferred`)
      continue
    }
    const leases: SessionLease[] = []
    try {
      for (const member of journal.members) leases.push(await options.acquireLease(member))
    } catch (error) {
      for (const lease of leases) await lease.release().catch(() => undefined)
      deferred.push(journal.id)
      log(`restore journal ${journal.id}: session lease held elsewhere; deferred (${(error as Error).message})`)
      continue
    }
    try {
      const terminal = await convergeJournal(options.home, checkpoint.dir, journal)
      if (terminal.phase === 'conflicted') {
        conflicted.push(terminal.id)
        log(`restore journal ${terminal.id}: ${terminal.conflict ?? 'live drift'} — stopped instead of overwriting`)
      } else {
        converged.push(terminal.id)
      }
      // Remove staged temporaries the resume left behind in member dirs.
      for (const member of journal.members) {
        const liveDir = memberDir(options.home, member.dir)
        try {
          for (const name of await readdir(liveDir)) {
            if (name.endsWith('.restore.tmp')) await rm(join(liveDir, name), { force: true })
          }
        } catch {
          // member dir removed alongside — nothing to sweep
        }
      }
    } catch (error) {
      deferred.push(journal.id)
      log(`restore journal ${journal.id}: convergence failed (${error instanceof Error ? error.message : String(error)})`)
    } finally {
      for (const lease of leases) await lease.release().catch(() => undefined)
    }
  }
  return { converged, conflicted, deferred }
}
