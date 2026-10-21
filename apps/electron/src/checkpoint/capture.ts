/**
 * Exit-time checkpoint capture (docs/electron/session-checkpoint-restore.md).
 * A candidate stages the covered `$DSH_HOME` set under
 * `checkpoints/<id>.tmp/`, sessions are validated through the bundled
 * Harness's real read path, failures keep their previous verified copy
 * carried into the candidate, and the candidate commits by directory rename.
 * Every committed checkpoint is self-contained, so retention may delete any
 * checkpoint whose sessions are covered by newer ones.
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, linkSync } from 'node:fs'
import { copyFile, mkdir, open, readdir, rm, stat, statfs } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { renameDesktopPath } from '../atomic-file.ts'
import {
  checkpointsRoot,
  readManifest,
  writeManifest,
  type CheckpointFileEntry,
  type CheckpointManifest,
  type CheckpointSessionEntry,
  type CheckpointSessionHeader,
  type CheckpointValidator,
} from './manifest.ts'
import { readShutdownReportFile } from '../harness/shutdown-report.ts'
import { listPendingRestores } from './pending.ts'
import { listRestoreJournals, readRestoreJournal } from './journal.ts'
import { createDurableDirectory, removeStagedTree, syncDirectoryTree } from './files.ts'
import { isPromotableReport } from './promotion.ts'

/** Files that never belong to a checkpoint copy: transient locks and staged artifacts. */
const EXCLUDED_NAMES = /\.(tmp|lock)$|^session\.lock$|^session\.migration\./

/** Managed profile files backed up inside every checkpoint (restore itself is post-v1). */
const PROFILE_FILE_SET = new Set([
  'cordis.yml', 'cordis.patch.yml', 'package.json',
  'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'compatibility.json',
])

/** Retained committed checkpoints beyond the coverage-protected ones. */
const CHECKPOINT_RETENTION_COUNT = 3

/** Free-space floor below which staging is skipped outright. */
const CHECKPOINT_HEADROOM_BYTES = 128 * 1024 * 1024

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** Enumerate regular files; only an optional root may be absent, descendants must remain readable. */
async function* walkFiles(root: string, optionalRoot = false): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (optionalRoot && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(path)
    } else if (entry.isFile()) {
      yield path
    }
  }
}

/** Enumerate live covered files as `$DSH_HOME`-relative posix paths. */
async function* coveredFiles(home: string): AsyncGenerator<string> {
  const sessionsRoot = join(home, 'sessions')
  for await (const file of walkFiles(sessionsRoot, true)) {
    const name = basename(file)
    if (EXCLUDED_NAMES.test(name)) continue
    yield `sessions/${toPosix(relative(sessionsRoot, file))}`
  }
  const profileDir = join(home, 'profiles', 'web')
  for (const name of PROFILE_FILE_SET) {
    try {
      if ((await stat(join(profileDir, name))).isFile()) yield `profiles/web/${name}`
    } catch {
      // absent managed file — nothing to back up
    }
  }
  try {
    if ((await stat(join(home, 'cordis.patch.yml'))).isFile()) yield 'cordis.patch.yml'
  } catch {
    // home-root patch is optional
  }
  const storagesDir = join(home, 'storages')
  try {
    for (const entry of await readdir(storagesDir, { withFileTypes: true })) {
      if (!entry.name.startsWith('session_projcache')) continue
      const path = join(storagesDir, entry.name)
      if (entry.isDirectory()) {
        for await (const file of walkFiles(path)) {
          if (EXCLUDED_NAMES.test(basename(file))) continue
          yield `storages/${toPosix(relative(storagesDir, file))}`
        }
      } else if (entry.isFile() && !EXCLUDED_NAMES.test(entry.name)) {
        yield `storages/${entry.name}`
      }
    }
  } catch {
    // storages absent — nothing covered
  }
  try {
    if ((await stat(join(home, '.env'))).isFile()) yield '.env'
  } catch {
    // defensive backup only when present
  }
}

/** Copy one live file into the candidate, hashing the stored bytes and syncing them durable. */
async function copyIntoCandidate(
  home: string, candidateDir: string, rel: string, signal?: AbortSignal,
): Promise<CheckpointFileEntry> {
  const sourcePath = join(home, rel)
  const sourceStat = await stat(sourcePath, { bigint: true })
  const destination = join(candidateDir, rel)
  await mkdir(dirname(destination), { recursive: true })
  signal?.throwIfAborted()
  const hash = createHash('sha256')
  let size = 0
  const read = createReadStream(sourcePath)
  const write = createWriteStream(destination, { mode: 0o600 })
  read.on('data', (chunk: string | Buffer) => {
    hash.update(chunk)
    size += chunk.length
  })
  await pipeline(read, write, { signal })
  // Windows FlushFileBuffers requires write access to the staged copy.
  const handle = await open(destination, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  return {
    path: rel,
    origin: 'captured',
    digest: { size, sha256: hash.digest('hex') },
    source: { path: rel, size: Number(sourceStat.size), mtimeNs: String(sourceStat.mtimeNs) },
  }
}

/**
 * Sessions-directory relative path of one stored file, or undefined for
 * non-session coverage. Session directories sit exactly two levels below
 * `sessions/` (`<project-key>/<encoded-session-id>/`).
 */
function sessionDirOf(rel: string): string | undefined {
  const parts = rel.split('/')
  if (parts[0] !== 'sessions' || parts.length < 4) return undefined
  return parts.slice(1, 3).join('/')
}

/** Result of the read-only validation worker for one session directory. */
export interface SessionValidationResult {
  readonly sessionId: string
  /** Directory relative to `sessions/`, POSIX separators. */
  readonly dir: string
  /** Stored header; restore derives closure and re-acquires the write lease from it. */
  readonly header?: CheckpointSessionHeader
  readonly ok: boolean
  readonly error?: string
}

/** Aggregate the worker reports; `sessionFormatVersion` binds the validator identity. */
export interface CheckpointValidationReport {
  readonly sessionFormatVersion: number
  readonly sessions: readonly SessionValidationResult[]
}

/** Inject hook for the validation worker (production spawns a child; tests validate in-process). */
export type ValidateSessions = (sessionsRoot: string, signal?: AbortSignal) => Promise<CheckpointValidationReport>

/** One staged candidate awaiting validation and commit. */
export interface StagedCandidate {
  readonly id: string
  /** `<id>.tmp` directory; removed on abort, renamed on commit. */
  readonly dir: string
  readonly files: CheckpointFileEntry[]
  /** Session dirs (posix, relative to `sessions/`) whose live files were copied. */
  readonly sessionDirs: Set<string>
}

/** Remove in-flight candidates left by an interrupted earlier capture. */
export async function sweepStaleCandidates(root: string, signal?: AbortSignal): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  for (const name of names.filter(name => name.endsWith('.tmp'))) {
    await removeStagedTree(join(root, name), signal)
  }
}

/**
 * Copy the covered set into a fresh `<id>.tmp` candidate.
 * @returns The staged candidate; callers own abort cleanup via {@link discardCandidate}.
 */
export async function stageCandidate(
  home: string, id: string, signal?: AbortSignal,
): Promise<StagedCandidate> {
  const root = checkpointsRoot(home)
  const dir = join(root, `${id}.tmp`)
  await createDurableDirectory(root, home)
  const files: CheckpointFileEntry[] = []
  const sessionDirs = new Set<string>()
  for await (const rel of coveredFiles(home)) {
    signal?.throwIfAborted()
    const entry = await copyIntoCandidate(home, dir, rel, signal)
    files.push(entry)
    const sessionDir = sessionDirOf(rel)
    if (sessionDir !== undefined) sessionDirs.add(sessionDir)
  }
  return { id, dir, files, sessionDirs }
}

/** Remove an uncommitted candidate; committed checkpoints are never discarded here. */
export async function discardCandidate(candidate: StagedCandidate, signal?: AbortSignal): Promise<void> {
  await removeStagedTree(candidate.dir, signal)
}

/**
 * Replace one session's copied files with the verified copy carried from a
 * previous checkpoint. Byte-identical materialization prefers a hard link —
 * both directories share one `$DSH_HOME` volume — and falls back to a copy.
 * @returns The carried copy's `{capturedAt, sourceCheckpointId}`, or undefined
 *          when the previous checkpoint holds no verified copy of it.
 */
export async function carryForwardSession(
  candidate: StagedCandidate,
  previousDir: string,
  previous: CheckpointManifest,
  sessionDir: string,
  signal?: AbortSignal,
): Promise<{ capturedAt: number; sourceCheckpointId: string } | undefined> {
  const prior = previous.sessions.find(entry => entry.dir === sessionDir)
  if (prior === undefined) return undefined
  // Keep the discarded live stats: stat-diff still needs the post-capture
  // live reference even for sessions whose bytes came from an older copy.
  const liveSources = new Map(
    candidate.files
      .filter((entry): entry is CheckpointFileEntry & { source: NonNullable<CheckpointFileEntry['source']> } =>
        sessionDirOf(entry.path) === sessionDir && entry.source !== undefined)
      .map(entry => [entry.path, entry.source]),
  )
  const kept = candidate.files.filter(entry => sessionDirOf(entry.path) !== sessionDir)
  candidate.files.length = 0
  candidate.files.push(...kept)
  await removeStagedTree(join(candidate.dir, 'sessions', ...sessionDir.split('/')), signal)
  const prefix = `sessions/${sessionDir}/`
  for (const entry of previous.files) {
    signal?.throwIfAborted()
    if (!entry.path.startsWith(prefix)) continue
    const source = join(previousDir, entry.path)
    const destination = join(candidate.dir, entry.path)
    await mkdir(dirname(destination), { recursive: true })
    try {
      linkSync(source, destination)
    } catch {
      await copyFile(source, destination)
      const handle = await open(destination, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    const liveSource = liveSources.get(entry.path)
    candidate.files.push({
      path: entry.path,
      origin: 'carried',
      digest: entry.digest,
      ...(liveSource === undefined ? {} : { source: liveSource }),
      sourceCheckpointId: previous.id,
    })
  }
  return { capturedAt: prior.capturedAt, sourceCheckpointId: prior.sourceCheckpointId }
}

/** Find the newest committed checkpoint with a readable manifest. */
export async function latestCheckpoint(root: string): Promise<{ dir: string; manifest: CheckpointManifest } | undefined> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return undefined
  }
  const committed = names.filter(name => !name.endsWith('.tmp')).sort().reverse()
  for (const name of committed) {
    const dir = join(root, name)
    const manifest = await readManifest(dir)
    if (manifest !== undefined) return { dir, manifest }
  }
  return undefined
}

/**
 * Write and sync the candidate before publishing it by directory rename.
 * Cancellation stops unpublished candidates; after rename, root-directory sync
 * must complete even when cancellation arrives during publication.
 * @param root - Checkpoint directory.
 * @param candidate - Staged files awaiting publication.
 * @param manifest - Verified session and file metadata.
 * @param signal - Cancellation observed before publication.
 * @returns Published checkpoint directory after its parent is flushed.
 */
export async function commitCandidate(
  root: string,
  candidate: StagedCandidate,
  manifest: CheckpointManifest,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  await writeManifest(candidate.dir, manifest)
  await syncDirectoryTree(candidate.dir, signal)
  signal?.throwIfAborted()
  const target = join(root, candidate.id)
  await renameDesktopPath(candidate.dir, target, signal === undefined ? {} : { signal })
  if (process.platform !== 'win32') {
    const handle = await open(root, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  return target
}

/**
 * Rotate old checkpoints. The newest commit and every checkpoint that uniquely
 * holds some session's last verified copy are protected; other committed
 * checkpoints past {@link CHECKPOINT_RETENTION_COUNT} are removed oldest-first.
 * Queued restore targets, intent-journal inputs, and unreadable manifests are also kept.
 * @param root - Checkpoint directory.
 * @param signal - Cancellation between retention operations.
 * @param protectedCheckpointIds - Targets referenced by confirmed restore requests or intent journals.
 * @returns Resolves after eligible checkpoints are removed.
 */
export async function pruneCheckpoints(
  root: string, signal?: AbortSignal, protectedCheckpointIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  const committed = names.filter(name => !name.endsWith('.tmp')).sort().reverse()
  if (committed.length <= CHECKPOINT_RETENTION_COUNT) return
  const manifests = new Map<string, CheckpointManifest>()
  for (const name of committed) {
    signal?.throwIfAborted()
    const manifest = await readManifest(join(root, name))
    if (manifest !== undefined) manifests.set(name, manifest)
  }
  const retainedIds = new Set<string>()
  let kept = 0
  for (const name of committed) {
    signal?.throwIfAborted()
    const manifest = manifests.get(name)
    const unique = manifest === undefined
      ? false
      : manifest.sessions.some(entry => !retainedIds.has(entry.sessionId))
    kept += 1
    if (kept <= CHECKPOINT_RETENTION_COUNT || unique || manifest === undefined || protectedCheckpointIds.has(name)) {
      for (const entry of manifest?.sessions ?? []) retainedIds.add(entry.sessionId)
      continue
    }
    await rm(join(root, name), { recursive: true, force: true })
  }
}

/** Outcome of one exit-time checkpoint attempt. */
export type ExitCheckpointOutcome =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'committed'; readonly id: string; readonly sessions: number }
  | { readonly kind: 'aborted'; readonly reason: string }

/** Free-space headroom required before staging; statfs failures skip capture. */
async function hasHeadroom(home: string): Promise<boolean> {
  try {
    const stats = await statfs(home)
    return stats.bavail * stats.bsize > CHECKPOINT_HEADROOM_BYTES
  } catch {
    return false
  }
}

export interface ExitCheckpointOptions {
  /** `$DSH_HOME`. */
  readonly home: string
  /** Pid of the Host child this run drained; binds promotion to this run's report. */
  readonly childPid: number
  /** Running app version recorded as the validator. */
  readonly appVersion: string
  /** Validation worker invoked on the candidate's sessions root. */
  readonly validate: ValidateSessions
  /** Cancellation leaves unfinished candidates for a later sweep; published checkpoints finish durability. */
  readonly signal?: AbortSignal | undefined
  readonly now?: (() => number) | undefined
  readonly log?: ((message: string) => void) | undefined
}

/**
 * Run one exit-time checkpoint: stage the covered set, validate every copied
 * session through the bundled read path, carry forward verified copies for
 * failures, re-validate the mixed set, then commit and rotate.
 */
export async function runExitCheckpoint(options: ExitCheckpointOptions): Promise<ExitCheckpointOutcome> {
  const log = options.log ?? (() => undefined)
  const report = await readShutdownReportFile(options.home)
  if (!isPromotableReport(report, options.childPid)) {
    return { kind: 'skipped', reason: 'shutdown report is not promotable' }
  }
  const root = checkpointsRoot(options.home)
  const now = options.now ?? (() => Date.now())
  const id = String(now())
  let candidate: StagedCandidate | undefined
  try {
    await sweepStaleCandidates(root, options.signal)
    if (!(await hasHeadroom(options.home))) {
      return { kind: 'skipped', reason: 'insufficient free space for checkpoint staging' }
    }
    const previous = await latestCheckpoint(root)
    candidate = await stageCandidate(options.home, id, options.signal)
    const validatorBase = { appVersion: options.appVersion }
    let finalReport: CheckpointValidationReport
    const first = await options.validate(join(candidate.dir, 'sessions'), options.signal)
    const failedDirs = new Set(
      first.sessions.filter(result => !result.ok).map(result => result.dir),
    )
    for (const dir of candidate.sessionDirs) {
      if (!first.sessions.some(result => result.dir === dir)) failedDirs.add(dir)
    }
    const carriedByDir = new Map<string, { capturedAt: number; sourceCheckpointId: string }>()
    if (failedDirs.size > 0) {
      const staged = candidate
      const exclude = async (dir: string): Promise<void> => {
        options.signal?.throwIfAborted()
        log(`checkpoint ${id}: session ${dir} failed validation and has no verified copy; excluded`)
        const kept = staged.files.filter(entry => sessionDirOf(entry.path) !== dir)
        staged.files.length = 0
        staged.files.push(...kept)
        staged.sessionDirs.delete(dir)
        await removeStagedTree(join(staged.dir, 'sessions', ...dir.split('/')), options.signal)
      }
      if (previous === undefined) {
        for (const dir of failedDirs) await exclude(dir)
      } else {
        for (const dir of failedDirs) {
          const carried = await carryForwardSession(candidate, previous.dir, previous.manifest, dir, options.signal)
          if (carried === undefined) {
            await exclude(dir)
          } else {
            carriedByDir.set(dir, carried)
            log(`checkpoint ${id}: session ${dir} kept previous verified copy from ${previous.manifest.id}`)
          }
        }
      }
      // A checkpoint mixing capture times re-validates the combined related-source
      // closure: any residual failure aborts the whole candidate rather than
      // committing an inconsistent set.
      const second = await options.validate(join(candidate.dir, 'sessions'), options.signal)
      const stillFailing = new Set(second.sessions.filter(result => !result.ok).map(result => result.dir))
      for (const dir of candidate.sessionDirs) {
        if (!second.sessions.some(result => result.dir === dir && result.ok)) stillFailing.add(dir)
      }
      if (stillFailing.size > 0) {
        return { kind: 'aborted', reason: `re-validation failed for ${[...stillFailing].join(', ')}` }
      }
      finalReport = second
    } else {
      finalReport = first
    }
    const validator: CheckpointValidator = {
      ...validatorBase,
      sessionFormatVersion: finalReport.sessionFormatVersion,
    }
    const sessions: CheckpointSessionEntry[] = finalReport.sessions.map((result) => {
      const carried = carriedByDir.get(result.dir)
      return {
        sessionId: result.sessionId,
        dir: result.dir,
        ...(result.header === undefined ? {} : { header: result.header }),
        capturedAt: carried?.capturedAt ?? now(),
        sourceCheckpointId: carried?.sourceCheckpointId ?? id,
        validator,
      }
    })
    const manifest: CheckpointManifest = {
      version: 1,
      id,
      capturedAt: now(),
      shutdown: report,
      files: candidate.files,
      sessions,
    }
    await commitCandidate(root, candidate, manifest, options.signal)
    candidate = undefined
    try {
      if (!options.signal?.aborted) {
        const protectedIds = await protectedRestoreCheckpoints(options.home)
        if (protectedIds !== undefined && !options.signal?.aborted) await pruneCheckpoints(root, options.signal, protectedIds)
      }
    } catch (error) {
      log(`checkpoint ${id}: retention stopped (${error instanceof Error ? error.message : String(error)})`)
    }
    return { kind: 'committed', id, sessions: sessions.length }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { kind: 'aborted', reason }
  } finally {
    if (candidate !== undefined && !options.signal?.aborted) {
      await discardCandidate(candidate, options.signal).catch(() => undefined)
    }
  }
}

/** Unreadable queues or journals prevent pruning because their checkpoint references are unknown. */
async function protectedRestoreCheckpoints(home: string): Promise<ReadonlySet<string> | undefined> {
  let pending
  try {
    pending = await listPendingRestores(home)
  } catch (_error) {
    // A transient read failure must not release confirmed restore targets.
    return undefined
  }
  const protectedIds = new Set(pending.flatMap(request =>
    request.checkpointId === undefined ? [] : [request.checkpointId]))
  for (const path of await listRestoreJournals(home)) {
    const journal = await readRestoreJournal(path)
    if (journal === undefined) return undefined
    if (journal.phase === 'intent') protectedIds.add(journal.checkpointId)
  }
  return protectedIds
}
