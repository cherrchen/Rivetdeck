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
import { access, copyFile, open, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { renameDesktopPath, writeDesktopFileAtomic } from '../atomic-file.ts'
import { checkpointsRoot, readManifest, type CheckpointManifest, type CheckpointSessionEntry } from './manifest.ts'
import {
  deleteRestoreJournal,
  listRestoreJournals,
  readRestoreJournal,
  writeRestoreJournal,
  type RestoreFingerprint,
  type RestoreJournal,
  type RestoreJournalMember,
  type RestorePublish,
} from './journal.ts'
import type { ValidateSessions } from './capture.ts'
import { createDurableDirectory, syncDirectory } from './files.ts'
import { dequeuePendingRestore, type PendingRestoreRequestId } from './pending.ts'
import { isSessionGenerationFile } from './session-files.ts'

/** Held `session.lock` write lease; released by closing it. */
export interface SessionLease {
  release(): Promise<void>
}

/** Session identity the lease seam may consult; a journal member qualifies. */
export type SessionLeaseSubject = Pick<RestoreJournalMember, 'sessionId' | 'dir' | 'header'>

/** Live headers with backend-derived directories; omitted headers require physical inventory checks. */
export type ListLiveSessions = () => Promise<readonly SessionLeaseSubject[]>

/** Lease provider: production resolves the backend seam; tests inject fakes. */
export type AcquireSessionLease = (subject: SessionLeaseSubject) => Promise<SessionLease>

/** Staged replacement name inside the member dir, next to the canonical file. */
function stagedName(canonical: string): string {
  return `${canonical}.restore.tmp`
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

/** sha256 of a file's current bytes. */
async function digestFile(path: string): Promise<{ size: number; sha256: string }> {
  const buffer = await readFile(path)
  return { size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }
}

/** Move a live file to quarantine, durably preserving its bytes before cross-volume unlink. */
async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await renameDesktopPath(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EXDEV') throw error
    const temporary = `${destination}.restore.tmp`
    await copyFile(source, temporary)
    const original = await digestFile(source)
    const copied = await digestFile(temporary)
    if (original.size !== copied.size || original.sha256 !== copied.sha256) {
      throw new Error(`quarantine copy ${destination} does not match ${source}`)
    }
    await syncFile(temporary)
    await renameDesktopPath(temporary, destination)
    await syncDirectory(dirname(destination))
    await unlink(source)
  }
  await syncDirectory(dirname(destination))
  await syncDirectory(dirname(source))
}

/** Flush file contents through a writable handle, including on Windows. */
async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
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
  // Windows FlushFileBuffers requires write access to the staged copy.
  const handle = await open(staged, 'r+')
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
  await createDurableDirectory(liveDir, home)
  await createDurableDirectory(quarantineMemberDir, home)
  const fingerprints = new Map(member.liveFiles.map(entry => [entry.name, entry]))
  const publish = new Map(member.publish.map(entry => [entry.name, entry]))
  const current = (await readdir(liveDir)).filter(isSessionGenerationFile)

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
        const liveDigest = await digestFile(livePath)
        const republished = plan !== undefined && liveDigest.sha256 === plan.digest.sha256
          && liveDigest.size === plan.digest.size
        if (!republished) {
          const preserved = await digestFile(quarantinePath)
          const copiedBeforeUnlink = await fingerprintMatches(livePath, fingerprint)
            && preserved.size === liveDigest.size && preserved.sha256 === liveDigest.sha256
          if (!copiedBeforeUnlink) {
            throw new RestoreConflict(join(member.dir, name), 'live file was recreated during the interrupted restore')
          }
          // A cross-volume copy, or a crash before source-directory fsync,
          // can leave both original names. Persist the retained bytes first.
          await syncFile(quarantinePath)
          await syncDirectory(quarantineMemberDir)
          await unlink(livePath)
          await syncDirectory(liveDir)
        }
      } else if (liveExists) {
        if (!(await fingerprintMatches(livePath, fingerprint))) {
          throw new RestoreConflict(join(member.dir, name), 'live file changed during the interrupted restore')
        }
        await moveFile(livePath, quarantinePath)
      } else if (!quarantined) {
        throw new RestoreConflict(join(member.dir, name), 'live file vanished during the interrupted restore')
      }
    }

    if (plan === undefined) continue
    if (await pathExists(stagedPath)) {
      // A leftover staged temp is ours by name but unverified bytes: a crash
      // can truncate the copy, so a digest mismatch is re-staged from the
      // checkpoint rather than published.
      const staged = await digestFile(stagedPath)
      if (staged.sha256 !== plan.digest.sha256 || staged.size !== plan.digest.size) {
        await rm(stagedPath, { force: true })
      }
    }
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
  // Persisted intents may have been created by a build with a broader publish set.
  for (const member of journal.members) {
    if (member.publish.some(plan => !isSessionGenerationFile(plan.name))
      || member.liveFiles.some(file => !isSessionGenerationFile(file.name))) {
      throw new Error(`restore journal ${journal.id} includes files outside session history`)
    }
  }
  for (const member of journal.members) {
    const liveDir = memberDir(home, member.dir)
    await createDurableDirectory(liveDir, home)
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

/** `SAFE_KEY_RE` in storage-json/src/per-record-unit.ts: a non-matching id can never own a row. */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/

/**
 * Remove member rows inside the legacy whole-unit projcache file. The unit
 * bootstraps the per-record tree when that tree is empty
 * (storage-json/src/per-record-unit.ts), so a fully invalidated member set
 * would otherwise resurrect stale rows on the next Host boot.
 */
async function finalizeLegacyProjcache(home: string, journal: RestoreJournal): Promise<void> {
  const legacyPath = join(home, 'storages', 'session_projcache.json')
  let document: { unit?: { name?: unknown }; tables?: unknown }
  try {
    document = JSON.parse(await readFile(legacyPath, 'utf8')) as typeof document
  } catch (error) {
    // Unreadable bytes may still contain stale rows; keep the journal for retry.
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (document.unit?.name !== 'session_projcache') return
  const tables = document.tables
  if (typeof tables !== 'object' || tables === null) return
  const sessions = (tables as Record<string, unknown>).sessions
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return
  const rows = sessions as Record<string, unknown>
  const members = new Set(journal.members.map(member => member.sessionId))
  const kept = Object.entries(rows).filter(([key]) => !members.has(key))
  if (kept.length === Object.keys(rows).length) return
  ;(tables as Record<string, unknown>).sessions = Object.fromEntries(kept)
  await writeDesktopFileAtomic(legacyPath, `${JSON.stringify(document)}\n`)
}

/** Invalidate the projcache rows of the target and its related-source closure; idempotent. */
async function finalizeProjcache(home: string, journal: RestoreJournal): Promise<void> {
  const rowsDir = join(home, 'storages', 'session_projcache', 'sessions')
  for (const member of journal.members) {
    // Unsafe ids are skipped rather than interpolated: the backend rejected
    // them at write, so no row exists under their name.
    if (!SAFE_KEY.test(member.sessionId)) continue
    await rm(join(rowsDir, `${member.sessionId}.json`), { force: true })
  }
  if (await pathExists(rowsDir)) await syncDirectory(rowsDir)
  await finalizeLegacyProjcache(home, journal)
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
 * @param checkpointDir - Committed checkpoint holding the publish bytes;
 *   consulted only by the intent-phase switch.
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
    if (current.pendingRequestId !== undefined) {
      await dequeuePendingRestore(home, current.targetSessionId, current.pendingRequestId)
    }
    await deleteRestoreJournal(home, current.id)
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

/**
 * Refuse uncovered descendants and physical sessions whose parentage is unknown.
 * Selected members retain their immutable stored headers even when the current
 * reader skips their newer generation; an unlisted new directory has no such evidence.
 * Callers hold every selected member lease throughout inspection and switching.
 */
async function uncoveredLiveSessions(
  home: string,
  members: readonly SessionLeaseSubject[],
  listLiveSessions: ListLiveSessions,
  signal?: AbortSignal,
): Promise<string[]> {
  const observed = new Map(members.map(member => [member.dir, member]))
  for (const member of await listLiveSessions()) observed.set(member.dir, member)
  const selected = new Map(members.map(member => [member.sessionId, member.dir]))
  const uncovered = new Set<string>()
  const root = join(home, 'sessions')
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  for (const project of projects) {
    signal?.throwIfAborted()
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const entry of await readdir(projectDir, { withFileTypes: true })) {
      signal?.throwIfAborted()
      if (!entry.isDirectory()) continue
      const dir = `${project.name}/${entry.name}`
      const names = await readdir(join(projectDir, entry.name))
      if (!names.some(isSessionGenerationFile)) continue
      const live = observed.get(dir)
      if (live === undefined) {
        uncovered.add(dir)
        continue
      }
      if (live.header.origin === 'subagent' && live.header.parentSession !== undefined
        && selected.has(live.header.parentSession) && selected.get(live.sessionId) !== dir) {
        uncovered.add(dir)
      }
    }
  }
  return [...uncovered].sort()
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

/**
 * Machine-readable refusal cause. Callers localize each key through the Main
 * dictionary, so this union carries substitutions, not product copy.
 */
export type RestoreRefusal =
  | { readonly key: 'host-running' }
  | { readonly key: 'no-checkpoint' }
  | { readonly key: 'incomplete-headers' }
  | { readonly key: 'live-closure-incomplete'; readonly dirs: readonly string[] }
  | { readonly key: 'revalidation-failed'; readonly dirs: readonly string[] }
  | { readonly key: 'lease-held'; readonly detail: string }

export type RestoreOutcome =
  | { readonly kind: 'restored'; readonly checkpointId: string; readonly sessions: readonly string[]; readonly quarantine: string }
  | { readonly kind: 'refused'; readonly reason: RestoreRefusal }
  | { readonly kind: 'conflicted'; readonly conflict: string; readonly journalId: string; readonly quarantine: string }
  | { readonly kind: 'failed'; readonly reason: string }

export interface RestoreSessionOptions {
  /** `$DSH_HOME`. */
  readonly home: string
  /** Session to roll back, with its related-source closure. */
  readonly sessionId: string
  /** Pin a specific checkpoint; newest containing the session when omitted. */
  readonly checkpointId?: string
  /** Durable pending request acknowledged before the completed journal is deleted. */
  readonly pendingRequestId?: PendingRestoreRequestId | undefined
  /** Refuse while the local Host is up — restore runs in a Host-down window. */
  readonly hostRunning?: (() => boolean) | undefined
  /** `session.lock` acquisition through the backend seam. */
  readonly acquireLease: AcquireSessionLease
  /** Current readable headers; physical inventory also detects sessions omitted by listing. */
  readonly listLiveSessions: ListLiveSessions
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
    return { kind: 'refused', reason: { key: 'host-running' } }
  }
  const found = await findCheckpoint(options.home, options.sessionId, options.checkpointId)
  if (found === undefined) {
    return { kind: 'refused', reason: { key: 'no-checkpoint' } }
  }
  const members = resolveRestoreClosure(found.manifest, options.sessionId)
  if (members === undefined) {
    return { kind: 'refused', reason: { key: 'incomplete-headers' } }
  }
  // Re-validate under the current build: stored verification is validator-bound
  // and does not carry across upgrades or downgrades.
  const report = await options.validate(join(found.dir, 'sessions'), options.signal)
  const invalid = members.filter(member => !report.sessions.some(result => result.dir === member.dir && result.ok))
  if (invalid.length > 0) {
    return { kind: 'refused', reason: { key: 'revalidation-failed', dirs: invalid.map(member => member.dir) } }
  }
  const now = options.now ?? (() => Date.now())
  // Session ids are unvalidated upstream strings, so journal and quarantine
  // names derive from the backend-encoded dir tail, which is path-safe by
  // construction.
  const journalId = `${now()}-${members[0]?.dir.split('/').pop() ?? 'restore'}`
  const leases: SessionLease[] = []
  const journalMembers: RestoreJournalMember[] = []
  try {
    for (const entry of members) {
      // Session dirs are always `<project>/<encoded id>`; anything else in a
      // manifest would let memberDir() escape the sessions root.
      const segments = entry.dir.split('/')
      if (segments.some(part => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
        throw new Error(`checkpoint ${found.manifest.id} lists an unsafe session dir ${entry.dir}`)
      }
      const member: RestoreJournalMember = {
        sessionId: entry.sessionId,
        dir: entry.dir,
        // relatedClosure refuses manifests without headers, so the stored
        // header is always present; it re-acquires the lease on resume.
        header: entry.header ?? { id: entry.sessionId },
        liveFiles: [],
        publish: found.manifest.files
          .filter(file => file.path.startsWith(`sessions/${entry.dir}/`)
            && isSessionGenerationFile(file.path.slice(`sessions/${entry.dir}/`.length)))
          .map(file => ({ name: file.path.slice(`sessions/${entry.dir}/`.length), digest: file.digest })),
      }
      // Acquire before fingerprinting: the lease proves no live writer, so
      // the recorded pre-state cannot race a foreign append.
      leases.push(await options.acquireLease(member))
      journalMembers.push(member)
    }
    const uncovered = await uncoveredLiveSessions(options.home, journalMembers, options.listLiveSessions, options.signal)
    if (uncovered.length > 0) {
      return { kind: 'refused', reason: { key: 'live-closure-incomplete', dirs: uncovered } }
    }
    for (const [index, member] of journalMembers.entries()) {
      const liveDir = memberDir(options.home, member.dir)
      const liveFiles: RestoreFingerprint[] = []
      try {
        for (const name of await readdir(liveDir)) {
          if (!isSessionGenerationFile(name)) continue
          const fileStat = await stat(join(liveDir, name), { bigint: true })
          liveFiles.push({ name, size: Number(fileStat.size), mtimeNs: String(fileStat.mtimeNs) })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
      }
      journalMembers[index] = { ...member, liveFiles }
    }
    let journal: RestoreJournal = {
      version: 1,
      id: journalId,
      phase: 'intent',
      checkpointId: found.manifest.id,
      targetSessionId: options.sessionId,
      ...(options.pendingRequestId === undefined ? {} : { pendingRequestId: options.pendingRequestId }),
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
        conflict: journal.conflict ?? 'unknown path',
        journalId: journal.id,
        quarantine: journal.quarantine,
      }
    }
    log(`restored session ${options.sessionId} from checkpoint ${found.manifest.id}; live files moved to ${journal.quarantine}`)
    return { kind: 'restored', checkpointId: found.manifest.id, sessions: members.map(member => member.sessionId), quarantine: journal.quarantine }
  } catch (error) {
    if ((error as Error).name === 'SessionAlreadyOwnedError') {
      return { kind: 'refused', reason: { key: 'lease-held', detail: (error as Error).message } }
    }
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    for (const lease of leases) await lease.release().catch(() => undefined)
  }
}

export interface ConvergeJournalsOptions {
  readonly home: string
  readonly acquireLease: AcquireSessionLease
  /** Current readable headers; physical inventory also detects sessions omitted by listing. */
  readonly listLiveSessions: ListLiveSessions
  readonly log?: ((message: string) => void) | undefined
  readonly signal?: AbortSignal | undefined
}

/** Outcome of one startup journal sweep, bucketed by what the caller must surface. */
export interface JournalConvergence {
  readonly converged: string[]
  readonly conflicted: string[]
  /** Retryable on the next launch: a live writer holds a lease, or a step failed. */
  readonly deferred: string[]
  /**
   * Intent journals whose checkpoint is gone: the interrupted switch can never
   * complete, so retry is futile — the caller offers an abandon choice.
   */
  readonly unresolvable: string[]
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
): Promise<JournalConvergence> {
  const log = options.log ?? (() => undefined)
  const converged: string[] = []
  const conflicted: string[] = []
  const deferred: string[] = []
  const unresolvable: string[] = []
  for (const path of await listRestoreJournals(options.home)) {
    options.signal?.throwIfAborted()
    const journal = await readRestoreJournal(path)
    if (journal === undefined) {
      log(`restore journal ${path} is unreadable; left in place`)
      deferred.push(basename(path, '.json'))
      continue
    }
    if (journal.phase === 'conflicted') {
      conflicted.push(journal.id)
      continue
    }
    // Only the intent phase needs checkpoint bytes: `committed`/`finalized`
    // journals finish projcache invalidation and record deletion without them.
    const checkpoint = await findCheckpoint(options.home, journal.targetSessionId, journal.checkpointId)
    if (checkpoint === undefined && journal.phase === 'intent') {
      unresolvable.push(journal.id)
      log(`restore journal ${journal.id}: checkpoint ${journal.checkpointId} is gone; the interrupted switch can never complete`)
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
      if (journal.phase === 'intent') {
        const uncovered = await uncoveredLiveSessions(options.home, journal.members, options.listLiveSessions, options.signal)
        if (uncovered.length > 0) throw new Error(`restore journal ${journal.id} has uncovered live sessions: ${uncovered.join(', ')}`)
      }
      const terminal = await convergeJournal(options.home, checkpoint?.dir ?? '', journal)
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
  return { converged, conflicted, deferred, unresolvable }
}
