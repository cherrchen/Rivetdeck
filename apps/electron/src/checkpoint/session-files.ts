/**
 * Canonical Session-generation filenames, mirroring the JSONL backend grammar
 * (`dsh-session-format` `filename.ts` plus the `dsh-session-persistence-jsonl`
 * `format.ts` compression suffix) so checkpoint code never claims extension
 * artifacts such as `session.jsonl.index` or `session.v4.jsonl.backup`. Keep in
 * sync with the backend grammar.
 */

/**
 * Shape of a canonical generation basename: `session.jsonl` for version zero or
 * `session.vN.jsonl` (`N` a positive integer without leading zeros), each
 * optionally `.zstd`-suffixed. The version's safe-integer bound is enforced by
 * {@link parseSessionGeneration}, matching `parseGenerationLogFilename`.
 */
const GENERATION_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/

/**
 * Parse the generation version a canonical filename encodes.
 * @param name - One entry from a session directory.
 * @returns Its format version (`session.jsonl` is 0), or `undefined` when the
 *   name is not a canonical generation file.
 */
export function parseSessionGeneration(name: string): number | undefined {
  const match = GENERATION_NAME.exec(name)
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
