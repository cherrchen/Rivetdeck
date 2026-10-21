/**
 * Canonical Session-generation filenames for the deployment's configured
 * artifact encoding, mirroring `parseGenerationLogFilename` in
 * `dsh-session-persistence-jsonl/format.ts` — one compression suffix, then
 * the `dsh-session-format/filename.ts` stem grammar. Checkpoint code never
 * claims names outside that grammar: extension artifacts such as
 * `session.jsonl.index`, staged names, and the opposite encoding's
 * generations (plaintext `session.jsonl` under a zstd mount) are foreign —
 * the backend itself refuses them with `encodingMismatch`. Keep in sync with
 * the backend grammar and the mounted encoding.
 */

/** Physical encoding selected for JSONL session artifacts — mirrors `JsonlCompression` upstream. */
export type SessionLogCompression = 'zstd' | 'none'

/**
 * The artifact encoding the deployment mounts: the base bundle's
 * `session-persistence-jsonl` patch sets no `compression` (backend default
 * `zstd`), and `mountSessionsBackend` passes this same constant. A mount owns
 * one encoding only — the backend throws `encodingMismatch` on the opposite
 * encoding's generations rather than reading them.
 */
export const SESSION_LOG_COMPRESSION: SessionLogCompression = 'zstd'

/** Artifact suffix per encoding — mirrors `compressionSuffix` in `format.ts`. */
const COMPRESSION_SUFFIXES: Record<SessionLogCompression, string> = { zstd: '.zstd', none: '' }

/** Artifact suffix for {@link SESSION_LOG_COMPRESSION}. */
const COMPRESSION_SUFFIX = COMPRESSION_SUFFIXES[SESSION_LOG_COMPRESSION]

/**
 * Canonical generation basename without its compression suffix: `session.jsonl`
 * for version zero or `session.vN.jsonl` (`N` a positive integer without
 * leading zeros), mirroring `dsh-session-format` `filename.ts`.
 */
const GENERATION_STEM = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/

/**
 * Parse the generation version a canonical filename encodes under the
 * configured encoding.
 * @param name - One entry from a session directory.
 * @returns Its format version (the unversioned `session.jsonl` stem is 0),
 *   or `undefined` when the name is not a canonical generation file.
 */
export function parseSessionGeneration(name: string): number | undefined {
  if (!name.endsWith(COMPRESSION_SUFFIX)) return undefined
  const match = GENERATION_STEM.exec(name.slice(0, name.length - COMPRESSION_SUFFIX.length))
  if (match === null) return undefined
  if (match[1] === undefined) return 0
  const version = Number(match[1])
  return Number.isSafeInteger(version) ? version : undefined
}

/**
 * True for session-generation files a restore owns inside a session dir —
 * exactly the names {@link parseSessionGeneration} accepts.
 * @param name - One entry from a session directory.
 * @returns Whether the name is a canonical generation file.
 */
export function isSessionGenerationFile(name: string): boolean {
  return parseSessionGeneration(name) !== undefined
}
