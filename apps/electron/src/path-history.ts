/** Durable per-install record of the resolved write roots the product has used: every
 * userData root (including --user-data-dir relocations) and every DSH_HOME. The Windows
 * uninstaller merges it into protection and cleanup-candidate sets; a full-removal
 * request proceeds only while the record can prove no unrecorded roots existed. */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withDesktopFileWriter, writeDesktopFileAtomic } from './atomic-file.ts'

/** Record file written beside the installed executable; the replacing uninstaller migrates
 * it next to the default userData so the succeeding install adopts it. */
export const PATH_HISTORY_FILE = 'rivetdeck-path-history.ini'

/** Parsed path-history record: `complete` is false whenever history cannot prove it
 * covered every root the product ever used (absent file, first record after an upgrade). */
export interface PathHistoryRecord {
  complete: boolean
  userData: string[]
  dshHome: string[]
}

/**
 * Parse the line-oriented record. Unknown keys are ignored so newer versions' claims do
 * not break older readers; malformed lines are skipped rather than failing the launch.
 * @param content Raw UTF-8 record content.
 * @returns Record with deduplicated paths in file order.
 */
export function parsePathHistory(content: string): PathHistoryRecord {
  const record: PathHistoryRecord = { complete: false, userData: [], dshHome: [] }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const equals = line.indexOf('=')
    if (equals < 0) continue
    const key = line.slice(0, equals).trim()
    const value = line.slice(equals + 1).trim()
    if (key === 'complete') record.complete = value === '1'
    else if (key === 'userData' && value !== '') pushUnique(record.userData, value)
    else if (key === 'dshHome' && value !== '') pushUnique(record.dshHome, value)
  }
  return record
}

/**
 * Render the record as CRLF `key=value` lines; complete first so a truncated read still
 * carries the completeness proof.
 * @param record Merged record.
 * @returns Persistable record content.
 */
export function renderPathHistory(record: PathHistoryRecord): string {
  const lines = [`complete=${record.complete ? '1' : '0'}`]
  for (const path of record.userData) lines.push(`userData=${path}`)
  for (const path of record.dshHome) lines.push(`dshHome=${path}`)
  return lines.join('\r\n') + '\r\n'
}

/**
 * Merge this launch's resolved userData and DSH_HOME into the install's durable record.
 * Values accumulate — earlier roots are never overwritten or dropped. When the record is
 * absent but the replaced uninstaller migrated one beside the default userData, that
 * record is adopted (its completeness survives the upgrade); with no record at all the
 * launch starts a new record marked incomplete, because the first record after an upgrade
 * cannot prove what ran before it.
 * @param options installDir (directory of the running executable), appDataDir (fixed
 *   roaming root where migrated records land), plus this launch's resolved roots.
 * @returns The merged record, or undefined when nothing could be persisted.
 */
export async function mergeLaunchPathHistory(options: {
  installDir: string
  appDataDir: string
  userData: string
  dshHome: string
}): Promise<PathHistoryRecord | undefined> {
  const recordPath = join(options.installDir, PATH_HISTORY_FILE)
  const migratedPath = join(options.appDataDir, PATH_HISTORY_FILE)
  return withDesktopFileWriter(recordPath, async () => {
    const existing = await readRecord(recordPath)
    const migrated = existing === undefined ? await readRecord(migratedPath) : undefined
    const record: PathHistoryRecord = existing
      ?? migrated
      ?? { complete: false, userData: [], dshHome: [] }
    pushUnique(record.userData, options.userData)
    pushUnique(record.dshHome, options.dshHome)
    await writeDesktopFileAtomic(recordPath, renderPathHistory(record))
    if (migrated !== undefined) await rm(migratedPath, { force: true })
    return record
  })
}

/** Read one record file; absent or unreadable files resolve to undefined. */
async function readRecord(path: string): Promise<PathHistoryRecord | undefined> {
  try {
    return parsePathHistory(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Windows path comparison is case-insensitive; other platforms compare verbatim. */
function pushUnique(paths: string[], path: string): void {
  const same = process.platform === 'win32'
    ? (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
    : (left: string, right: string) => left === right
  if (!paths.some(existing => same(existing, path))) paths.push(path)
}
