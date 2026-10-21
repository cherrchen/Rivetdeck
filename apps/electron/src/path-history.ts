/** Durable per-install record of the resolved write roots the product has used: every
 * userData root (including --user-data-dir relocations) and every DSH_HOME. The Windows
 * uninstaller merges it into protection and cleanup-candidate sets; a full-removal
 * request proceeds only while the record can prove no unrecorded roots existed. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { writeDesktopFileAtomic } from './atomic-file.ts'

/** Record file stored beside the default userData (`%APPDATA%`), a location the app can
 * always write. */
export const PATH_HISTORY_FILE = 'rivetdeck-path-history.ini'

/** Parsed path-history record: `complete` is false whenever history cannot prove it
 * covered every root in this install epoch (absent file, upgrade, or retired epoch). */
export interface PathHistoryRecord {
  complete: boolean
  userData: string[]
  dshHome: string[]
  /** Verbatim lines this reader does not recognize — unknown keys, malformed lines, and
   * path claims with empty values. Rewrites carry them unchanged so a merge never erases
   * a protection claim only a newer version (or the uninstaller's stricter parser)
   * understands; the native reader already refuses full removal on any such line. */
  unrecognized: string[]
}

/**
 * Parse the line-oriented record. Keys compare case-insensitively, matching the native
 * reader; empty lines and comments are dropped. Anything else that is not a recognized
 * claim is preserved verbatim in `unrecognized` rather than silently erased by the next
 * rewrite. `retired=1` clears cleanup candidates and completeness regardless of line
 * order, while preserving every protected-home and unknown claim.
 * @param content Raw UTF-8 record content.
 * @returns Record with deduplicated paths in file order.
 */
export function parsePathHistory(content: string): PathHistoryRecord {
  const record: PathHistoryRecord = { complete: false, userData: [], dshHome: [], unrecognized: [] }
  let retired = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const equals = line.indexOf('=')
    if (equals < 0) {
      record.unrecognized.push(line)
      continue
    }
    const key = line.slice(0, equals).trim().toLowerCase()
    const value = line.slice(equals + 1).trim()
    if (key === 'retired' && value === '1') retired = true
    else if (key === 'complete') record.complete = value === '1'
    else if (key === 'userdata' && value !== '') pushUnique(record.userData, value)
    else if (key === 'dshhome' && value !== '') pushUnique(record.dshHome, value)
    else record.unrecognized.push(line)
  }
  if (retired) {
    record.complete = false
    record.userData = []
  }
  return record
}

/**
 * Render CRLF claims for the active epoch, retaining unrecognized lines. A parsed
 * retirement marker is consumed; its old candidates and completeness are already reset.
 * @param record Merged record.
 * @returns Persistable record content.
 */
export function renderPathHistory(record: PathHistoryRecord): string {
  const lines = [`complete=${record.complete ? '1' : '0'}`]
  for (const path of record.userData) lines.push(`userData=${path}`)
  for (const path of record.dshHome) lines.push(`dshHome=${path}`)
  for (const line of record.unrecognized) lines.push(line)
  return lines.join('\r\n') + '\r\n'
}

/**
 * Merge this launch's resolved userData and DSH_HOME into the install's durable record.
 * UserData roots accumulate within the current install epoch; retiring an epoch drops
 * its cleanup candidates and completeness, while homes and unrecognized claims survive.
 * An installer seed attests only the default userData root. Discovering any other
 * unrecorded root makes history incomplete because its earlier homes are unknown.
 * A cross-process writer lock covers the entire read-modify-write cycle, including
 * launches with different userData roots.
 * The record lives beside the default userData so an unelevated process can always
 * update it. With no record at all the
 * launch starts a new record marked incomplete, because the first record cannot prove
 * which roots ran before it existed. A record that exists but cannot be read is left
 * untouched — overwriting it could erase claims the uninstaller would otherwise honor.
 * @param options appDataDir (fixed roaming root that survives install-directory removal),
 *   defaultUserData (the root checked by the installer), and this launch's resolved roots.
 * @returns The merged record.
 * @throws Read or write failures other than an absent record. Callers must stop startup
 *   on failure so an older complete record never omits a home this launch starts using.
 */
export async function mergeLaunchPathHistory(options: {
  appDataDir: string
  defaultUserData: string
  userData: string
  dshHome: string
}): Promise<PathHistoryRecord> {
  const recordPath = join(options.appDataDir, PATH_HISTORY_FILE)
  await mkdir(options.appDataDir, { recursive: true, mode: 0o700 })
  return withFileLock(recordPath, async () => {
    const record: PathHistoryRecord = (await readRecord(recordPath))
      ?? { complete: false, userData: [], dshHome: [], unrecognized: [] }
    if (pushUnique(record.userData, options.userData)
      && !samePath(options.userData, options.defaultUserData)) record.complete = false
    pushUnique(record.dshHome, options.dshHome)
    await writeDesktopFileAtomic(recordPath, renderPathHistory(record))
    return record
  })
}

/** Read one record file; a missing file resolves to undefined while an unreadable file
 * throws, so callers never replace a record they could not inspect. */
async function readRecord(path: string): Promise<PathHistoryRecord | undefined> {
  try {
    return parsePathHistory(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Windows path comparison is case-insensitive; other platforms compare verbatim. */
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Append a previously unrecorded path and report whether it was added. */
function pushUnique(paths: string[], path: string): boolean {
  if (paths.some(existing => samePath(existing, path))) return false
  paths.push(path)
  return true
}
