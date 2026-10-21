/**
 * Startup drift detection (docs/electron/session-checkpoint-restore.md):
 * the newest committed checkpoint's manifest records live source stats, so a
 * stat-diff against `sessions/` files surfaces foreign writes made while the
 * Desktop was down, and a `session.vN` filename scan surfaces generation files
 * above the bundled format version (pollution mode A). Drift is only a hint —
 * hits confirm through the same read-only validation worker used for
 * promotion, because compatible foreign writes drift too. A drifted file whose
 * live bytes still match the manifest digest is the post-restore steady state,
 * not foreign drift, and is dropped by the digest check before validation.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { digestFile } from './files.ts'
import { checkpointsRoot, type CheckpointManifest, type CheckpointSessionEntry } from './manifest.ts'
import { latestCheckpoint, type CheckpointValidationReport } from './capture.ts'
import { isGenerationFileAnyEncoding, isSessionGenerationFile, parseSessionGeneration } from './session-files.ts'

export type DriftReason = 'changed' | 'missing' | 'extra' | 'newer-generation'

/** One drifted session directory found by comparing live files against the newest manifest. */
export interface DriftCandidate {
  readonly sessionId: string
  /** Session dir relative to `sessions/`, POSIX separators. */
  readonly dir: string
  readonly entry: CheckpointSessionEntry
  readonly reasons: readonly DriftReason[]
  /** Highest live `session.vN` generation above the bundled format version, when present. */
  readonly newerGeneration: number | undefined
}

/** Drift scan result against the newest committed checkpoint. */
export interface DriftDetection {
  readonly checkpointId: string
  readonly checkpointDir: string
  /** The scanned manifest; prompts derive the related-source closure from it. */
  readonly manifest: CheckpointManifest
  readonly candidates: readonly DriftCandidate[]
}

async function liveFileDigest(path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return (await digestFile(path, signal)).sha256
  } catch (_error) {
    signal?.throwIfAborted()
    return undefined
  }
}

/**
 * Compare the newest checkpoint's recorded live stats against the current
 * `sessions/` tree. Only sessions listed in the manifest are scanned: foreign
 * sessions created while Desktop was down have no verified copy and nothing
 * to restore, so detection stays silent about them.
 * @param home - `$DSH_HOME`.
 * @param options.formatVersion - Bundled `SESSION_FORMAT_VERSION`; the `session.vN`
 *   scan flags generations above it. The scan is skipped when undefined.
 * @param options.signal - Cancellation between directories and during file hashing.
 */
export async function detectCheckpointDrift(
  home: string,
  options?: { formatVersion?: number | undefined; signal?: AbortSignal | undefined },
): Promise<DriftDetection | undefined> {
  const found = await latestCheckpoint(checkpointsRoot(home))
  if (found === undefined) return undefined
  const { manifest } = found
  const candidates: DriftCandidate[] = []
  for (const entry of manifest.sessions) {
    options?.signal?.throwIfAborted()
    const liveDir = join(home, 'sessions', ...entry.dir.split('/'))
    const recorded = new Map<string, { size: number; mtimeNs: string; sha256: string; hasSource: boolean; carried: boolean }>()
    for (const file of manifest.files) {
      if (!file.path.startsWith(`sessions/${entry.dir}/`)) continue
      const name = file.path.slice(`sessions/${entry.dir}/`.length)
      if (!isSessionGenerationFile(name)) continue
      recorded.set(name, {
        size: file.source?.size ?? -1,
        mtimeNs: file.source?.mtimeNs ?? '',
        sha256: file.digest.sha256,
        hasSource: file.source !== undefined,
        carried: file.origin === 'carried',
      })
    }
    let liveNames: string[]
    try {
      // Foreign canonical names in any encoding are reported as `extra`;
      // ownership and version parsing stay on the configured encoding.
      liveNames = (await readdir(liveDir)).filter(isGenerationFileAnyEncoding)
    } catch {
      liveNames = []
    }
    const reasons = new Set<DriftReason>()
    let newerGeneration: number | undefined
    for (const [name, expect] of recorded) {
      const livePath = join(liveDir, name)
      const liveStat = await stat(livePath, { bigint: true }).catch(() => undefined)
      if (liveStat === undefined) {
        // `hasSource === false` means the file was already absent at capture.
        if (expect.hasSource) reasons.add('missing')
        continue
      }
      if (!expect.hasSource) {
        reasons.add('extra')
        continue
      }
      if (!expect.carried && Number(liveStat.size) === expect.size && String(liveStat.mtimeNs) === expect.mtimeNs) continue
      // Carried sources failed validation even when their stats match.
      // Bytes equal to the checkpoint are the post-restore steady state.
      if ((await liveFileDigest(livePath, options?.signal)) === expect.sha256) continue
      reasons.add('changed')
    }
    for (const name of liveNames) {
      const version = parseSessionGeneration(name)
      if (!recorded.has(name)) reasons.add('extra')
      if (version !== undefined && options?.formatVersion !== undefined
        && version > options.formatVersion) {
        newerGeneration = Math.max(newerGeneration ?? 0, version)
        reasons.add('newer-generation')
      }
    }
    if (reasons.size > 0) {
      candidates.push({
        sessionId: entry.sessionId,
        dir: entry.dir,
        entry,
        reasons: [...reasons],
        newerGeneration,
      })
    }
  }
  return { checkpointId: manifest.id, checkpointDir: found.dir, manifest, candidates }
}

/** A candidate confirmed unreadable under the bundled read path. */
export interface ConfirmedUnreadable {
  readonly sessionId: string
  readonly dir: string
  readonly entry: CheckpointSessionEntry
  readonly reasons: readonly DriftReason[]
  readonly newerGeneration: number | undefined
  /** Worker report error text, when the session was listed but failed to open. */
  readonly error: string | undefined
}

/**
 * Filter drift candidates through the validation worker report. A candidate
 * is confirmed when the live tree fails the read path — either the session
 * reports `ok: false`, or listing skipped it entirely (a `session.vN`
 * successor makes header admission refuse the whole directory). Drifted but
 * still-readable sessions are compatible foreign writes and stay silent.
 */
export function confirmUnreadable(
  detection: DriftDetection,
  report: CheckpointValidationReport,
): readonly ConfirmedUnreadable[] {
  const byDir = new Map(report.sessions.map(result => [result.dir, result]))
  return detection.candidates.flatMap((candidate) => {
    const result = byDir.get(candidate.dir)
    if (result?.ok === true) return []
    return [{
      sessionId: candidate.sessionId,
      dir: candidate.dir,
      entry: candidate.entry,
      reasons: candidate.reasons,
      newerGeneration: candidate.newerGeneration,
      error: result?.error,
    }]
  })
}
