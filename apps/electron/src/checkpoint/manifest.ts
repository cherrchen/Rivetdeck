/**
 * Checkpoint manifest schema (docs/electron/session-checkpoint-restore.md).
 * One committed checkpoint directory under `$DSH_HOME/electron/checkpoints/`
 * is self-contained: it physically holds the verified bytes of every session
 * it lists, whether captured at this exit or carried forward from an earlier
 * verified checkpoint.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeDesktopFileAtomic } from '../atomic-file.ts'
import { sessionDirRel } from './session-identity.ts'
import type { ShutdownReport } from '../harness/shutdown-report.ts'

/** Build identity that verified a session copy; verification does not carry over across builds. */
export interface CheckpointValidator {
  readonly appVersion: string
  readonly sessionFormatVersion: number
}

/** Live-file state observed at copy time; the startup stat-diff compares against it. */
export interface CheckpointSourceState {
  /** Path relative to `$DSH_HOME`, POSIX separators. */
  readonly path: string
  readonly size: number
  readonly mtimeNs: string
}

/** Digest bound to the bytes actually stored in the checkpoint. */
export interface CheckpointDigest {
  readonly size: number
  readonly sha256: string
}

export interface CheckpointFileEntry {
  /** Path relative to the checkpoint root, POSIX separators. */
  readonly path: string
  /** `captured` copies live bytes; `carried` materializes a previous verified copy. */
  readonly origin: 'captured' | 'carried'
  readonly digest: CheckpointDigest
  /** Live stat recorded at this capture; absent when the live file was already gone. */
  readonly source?: CheckpointSourceState
  /** Checkpoint whose capture produced these bytes; set when `origin` is `carried`. */
  readonly sourceCheckpointId?: string
}

/**
 * Stored session header fields the restore transaction relies on: `cwd`/`id`
 * derive the session directory and write lease, `parentSession`/`origin`
 * derive the related-source closure. Entries written by this version carry
 * the complete backend header object; older checkpoints may lack it, which
 * refuses their restore rather than guessing the closure.
 */
export interface CheckpointSessionHeader {
  readonly id: string
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: string
  readonly createdAt?: number
  readonly isSeeded?: boolean
  readonly delegationDepth?: number
  readonly agentPreset?: string
  readonly version?: number
  readonly type?: string
}

export interface CheckpointSessionEntry {
  readonly sessionId: string
  /** Session directory relative to the checkpoint's `sessions/` root, POSIX separators. */
  readonly dir: string
  /** Stored header as listed by the backend; complete JSON survives the manifest round-trip. */
  readonly header?: CheckpointSessionHeader
  /** When the stored bytes were captured; carried sessions keep their original value. */
  readonly capturedAt: number
  /** Checkpoint whose capture produced the stored bytes. */
  readonly sourceCheckpointId: string
  readonly validator: CheckpointValidator
}

export interface CheckpointManifest {
  readonly version: 1
  /** Committed directory name under `checkpoints/`; equals the capture-time epoch string. */
  readonly id: string
  readonly capturedAt: number
  /** The promotable shutdown report that authorized this capture. */
  readonly shutdown: ShutdownReport
  readonly files: readonly CheckpointFileEntry[]
  readonly sessions: readonly CheckpointSessionEntry[]
}

/** Root holding every committed checkpoint plus in-flight `<id>.tmp` candidates. */
export function checkpointsRoot(home: string): string {
  return join(home, 'electron', 'checkpoints')
}

/** Manifest path inside one checkpoint directory. */
export function manifestPath(checkpointDir: string): string {
  return join(checkpointDir, 'manifest.json')
}

/** Persist the manifest atomically inside the candidate before the directory rename publishes it. */
export async function writeManifest(checkpointDir: string, manifest: CheckpointManifest): Promise<void> {
  await writeDesktopFileAtomic(manifestPath(checkpointDir), `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/** A single path segment: no separators, no traversal. */
export function isPathSegment(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && !value.includes('/') && !value.includes('\\') && !value.includes('\0')
    && value !== '.' && value !== '..'
}

/** A POSIX-relative path made only of safe segments. */
function isRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.split('/').every(isPathSegment)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Stored digest fields; journals reuse this guard for publish entries. */
export function isCheckpointDigest(value: unknown): value is CheckpointDigest {
  return isRecord(value) && typeof value.sha256 === 'string' && typeof value.size === 'number'
}

/**
 * Check stored header fields and bind the write-lease identity to its file directory.
 * @param header - Header read from durable JSON.
 * @param sessionId - Record's session identifier.
 * @param dir - Record's directory relative to sessions.
 * @returns Whether the header is valid and identifies exactly this directory.
 */
export function isSessionIdentity(header: unknown, sessionId: string, dir: string): header is CheckpointSessionHeader {
  if (!isRecord(header) || typeof header.id !== 'string' || header.id.length === 0 || header.id !== sessionId) return false
  for (const key of ['cwd', 'parentSession', 'origin', 'agentPreset', 'type']) {
    if (header[key] !== undefined && typeof header[key] !== 'string') return false
  }
  if (header.cwd === '') return false
  for (const key of ['createdAt', 'delegationDepth', 'version']) {
    if (header[key] !== undefined && (typeof header[key] !== 'number' || !Number.isFinite(header[key]))) return false
  }
  if (header.isSeeded !== undefined && typeof header.isSeeded !== 'boolean') return false
  return sessionDirRel(typeof header.cwd === 'string' ? header.cwd : undefined, header.id) === dir
}

/**
 * Durable-boundary shape check: a version-1 record whose `files`/`sessions`
 * lists or session dirs do not fit is treated as unreadable, never half-read.
 */
function isManifest(parsed: unknown): parsed is CheckpointManifest {
  if (!isRecord(parsed)) return false
  if (parsed.version !== 1 || typeof parsed.id !== 'string' || typeof parsed.capturedAt !== 'number'
    || !Array.isArray(parsed.files) || !Array.isArray(parsed.sessions)) return false
  for (const file of parsed.files) {
    if (!isRecord(file) || !isRelativePath(file.path) || !isCheckpointDigest(file.digest)) return false
  }
  for (const entry of parsed.sessions) {
    if (!isRecord(entry)
      || typeof entry.sessionId !== 'string' || !isRelativePath(entry.dir)
      || (entry.header !== undefined && !isSessionIdentity(entry.header, entry.sessionId, entry.dir))) return false
  }
  return true
}

/**
 * Read one committed manifest, tolerating absence and malformed content.
 * @param checkpointDir - Committed checkpoint directory.
 * @returns The manifest, or undefined when unreadable.
 */
export async function readManifest(checkpointDir: string): Promise<CheckpointManifest | undefined> {
  let raw: string
  try {
    raw = await readFile(manifestPath(checkpointDir), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return isManifest(parsed) ? parsed : undefined
}
