/**
 * Read-only session validation through the bundled Harness's real read path.
 * The backend modules load through the supervised `dsh` install anchor, so the
 * validating build is exactly the one the packaged Host mounts. The mounted
 * copy is never write-opened: `list` plus `open(id, 'read')` followed by full
 * pagination performs decompress, header admission, event admission, and the
 * historical-migration path including related-source reads — and writes
 * nothing (phase-0 probe verified a byte-identical tree).
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { CheckpointValidationReport, SessionValidationResult } from './capture.ts'

/** Minimal typed surface of `@deepseek-ai/dsh-session-persistence-jsonl` used here. */
interface BackendModule {
  readonly default: unknown
}

// The bundled lib is a single-file build: `sessionDir` is not re-exported, so
// the session-directory mapping below mirrors `format.ts` exactly — keep it in
// sync with `encodeSegment`/`projectKey`/`sessionDir` upstream.
function encodeSegment(raw: string): string {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (const ch of raw) {
    // codePointAt is defined for every unit of a non-empty string.
    const code = ch.codePointAt(0) ?? 0
    out += /^[A-Za-z0-9._-]$/.test(ch) && ch !== '~'
      ? ch
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

function projectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (const ch of cwd) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (/^[A-Za-z0-9._-]$/.test(ch) && ch !== '~') {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Session directory relative to the sessions root, POSIX separators. */
function sessionDirRel(cwd: string | undefined, id: string): string {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd)
  return `${project}/${encodeSegment(id)}`
}

interface CordisModule {
  readonly Context: new () => {
    plugin(plugin: unknown, config: unknown): Promise<unknown>
    sessionPersistence: {
      list(): Promise<readonly { header: { id: unknown; cwd?: string } }[]>
      open(id: string, mode: 'read'): Promise<{
        read(offset: number): Promise<{ events: readonly { seq: number }[] }>
        close(): Promise<void>
      }>
    }
    fiber: { dispose(): Promise<void> }
  }
}

interface SessionModule {
  readonly SESSION_FORMAT_VERSION: number
}

/** Load the backend plus its own cordis/session copies, resolved from the supervised install. */
async function loadBackendModules(installAnchor: string): Promise<{
  backend: BackendModule
  cordis: CordisModule
  session: SessionModule
}> {
  const backendRequire = createRequire(installAnchor)
  const backend = await import(pathToFileURL(backendRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href) as BackendModule
  const cordis = await import(pathToFileURL(backendRequire.resolve('@deepseek-ai/cordis')).href) as CordisModule
  const session = await import(pathToFileURL(backendRequire.resolve('@deepseek-ai/dsh-session')).href) as SessionModule
  return { backend, cordis, session }
}

/**
 * Validate every session the backend lists under one sessions root.
 * Sessions skipped by listing (header admission failure) never appear here —
 * the caller treats copied-but-unlisted directories as failed.
 * @param options.sessionsRoot - Sessions root to mount read-only.
 * @param options.installAnchor - `@deepseek-ai/dsh/package.json` of the supervised install.
 * @param options.signal - Cancellation between sessions.
 * @returns Per-session outcomes plus the format version the backend reports.
 */
export async function validateSessionsRoot(options: {
  sessionsRoot: string
  installAnchor: string
  signal?: AbortSignal | undefined
}): Promise<CheckpointValidationReport> {
  if (!existsSync(options.sessionsRoot)) {
    return { sessionFormatVersion: -1, sessions: [] }
  }
  const { backend, cordis, session } = await loadBackendModules(options.installAnchor)
  const ctx = new cordis.Context()
  try {
    // `compression` matches the deployment: the base patch sets no override and
    // the backend default is zstd.
    await ctx.plugin(backend.default, { root: options.sessionsRoot, compression: 'zstd' })
    const persistence = ctx.sessionPersistence
    const results: SessionValidationResult[] = []
    for (const snapshot of await persistence.list()) {
      options.signal?.throwIfAborted()
      const id = String(snapshot.header.id)
      const dir = sessionDirRel(snapshot.header.cwd, id)
      try {
        const handle = await persistence.open(id, 'read')
        try {
          let offset = 0
          for (;;) {
            options.signal?.throwIfAborted()
            const page = await handle.read(offset)
            const last = page.events[page.events.length - 1]
            if (last === undefined) break
            offset = last.seq + 1
          }
        } finally {
          await handle.close()
        }
        results.push({ sessionId: id, dir, ok: true })
      } catch (error) {
        results.push({
          sessionId: id,
          dir,
          ok: false,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        })
      }
    }
    return { sessionFormatVersion: session.SESSION_FORMAT_VERSION, sessions: results }
  } finally {
    await ctx.fiber.dispose().catch(() => undefined)
  }
}
