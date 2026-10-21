/** Session directory mapping shared by validation and durable recovery records. */

// The bundled lib is a single-file build: `sessionDir` is not re-exported, so
// the session-directory mapping below mirrors `format.ts` exactly — including
// its UTF-16 code-unit iteration (`charCodeAt`), which emits `~D83D~DE00` for a
// non-BMP character, never a single `~1F600`. Keep it in sync upstream.
function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Derive the backend directory relative to the sessions root, with POSIX separators.
 * @param cwd - Stored project directory, or undefined for a projectless session.
 * @param id - Stored session identifier.
 * @returns The directory whose write lease protects this session.
 */
export function sessionDirRel(cwd: string | undefined, id: string): string {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd)
  return `${project}/${encodeSegment(id)}`
}
