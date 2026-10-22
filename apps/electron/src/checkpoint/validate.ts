/**
 * Read-only session validation through the bundled Harness's real read path.
 * The backend modules resolve through the supervised install's `dsh-base`
 * bundle — the package that declares them as production dependencies — so the
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
import type { CheckpointSessionHeader } from './manifest.ts'
import type { ListLiveSessions } from './restore.ts'
import { sessionDirRel } from './session-identity.ts'
import { SESSION_LOG_COMPRESSION } from './session-files.ts'

/** Minimal typed surface of `@deepseek-ai/dsh-session-persistence-jsonl` used here. */
interface BackendModule {
  readonly apply: unknown
}

interface CordisModule {
  readonly Context: new () => {
    plugin(plugin: unknown, config: unknown): Promise<unknown>
    sessionPersistence: {
      list(): Promise<readonly { header: CheckpointSessionHeader }[]>
      open(id: string, access: 'read' | 'write'): Promise<{
        read(offset: number): Promise<{ events: readonly { seq: number }[] }>
        append(events: readonly Record<string, unknown>[]): Promise<void>
        flush(): Promise<void>
        close(): Promise<void>
      }>
      acquireWriteLease(header: CheckpointSessionHeader): Promise<{ release(): Promise<void> }>
    }
    fiber: { dispose(): Promise<void> }
  }
}

interface SessionModule {
  readonly SESSION_FORMAT_VERSION: number
}

/**
 * `createRequire` rooted at the install's `dsh-base` package. The `dsh` anchor
 * reaches only the CLI's own production dependencies, while the backend lives
 * in the base bundle's production set — resolving from the anchor directly
 * cannot find it in a packaged install.
 * @param installAnchor - `@deepseek-ai/dsh/package.json` of the supervised install.
 * @returns A require that resolves the backend, cordis, and session modules.
 */
function backendRequire(installAnchor: string): NodeJS.Require {
  const installRequire = createRequire(installAnchor)
  return createRequire(installRequire.resolve('@deepseek-ai/dsh-base/package.json'))
}

/** Load the backend plus its own cordis/session copies, resolved from the supervised install. */
async function loadBackendModules(installAnchor: string): Promise<{
  backend: BackendModule
  cordis: CordisModule
  session: SessionModule
}> {
  const requireFromBase = backendRequire(installAnchor)
  const backend = await import(pathToFileURL(requireFromBase.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href) as BackendModule
  const cordis = await import(pathToFileURL(requireFromBase.resolve('@deepseek-ai/cordis')).href) as CordisModule
  const session = await import(pathToFileURL(requireFromBase.resolve('@deepseek-ai/dsh-session')).href) as SessionModule
  return { backend, cordis, session }
}

/**
 * Read the bundled `SESSION_FORMAT_VERSION` without mounting the backend —
 * the vN filename scan needs only the constant, not a cordis context.
 * @param installAnchor - `@deepseek-ai/dsh/package.json` of the supervised install.
 * @returns The format version the supervised build reads and writes.
 */
export async function resolveSessionFormatVersion(installAnchor: string): Promise<number> {
  const session = await import(
    pathToFileURL(backendRequire(installAnchor).resolve('@deepseek-ai/dsh-session')).href,
  ) as SessionModule
  return session.SESSION_FORMAT_VERSION
}

/** A mounted sessions backend; `dispose` tears down the cordis context. */
export interface MountedSessionsBackend {
  readonly sessionFormatVersion: number
  readonly persistence: InstanceType<CordisModule['Context']>['sessionPersistence']
  /** Read admitted headers and their backend-derived directories without reading event bodies. */
  readonly listSessions: ListLiveSessions
  dispose(): Promise<void>
}

/**
 * Mount the bundled JSONL backend on one sessions root in-process. Restore
 * uses this in Main for `acquireWriteLease`; validation uses it inside the
 * worker. `compression` is {@link SESSION_LOG_COMPRESSION} — the single
 * deployment encoding the checkpoint filename grammar mirrors.
 */
export async function mountSessionsBackend(
  sessionsRoot: string,
  installAnchor: string,
): Promise<MountedSessionsBackend> {
  const { backend, cordis, session } = await loadBackendModules(installAnchor)
  const ctx = new cordis.Context()
  try {
    await ctx.plugin(backend, { root: sessionsRoot, compression: SESSION_LOG_COMPRESSION })
  } catch (error) {
    await ctx.fiber.dispose().catch(() => undefined)
    throw error
  }
  return {
    sessionFormatVersion: session.SESSION_FORMAT_VERSION,
    persistence: ctx.sessionPersistence,
    listSessions: async () => (await ctx.sessionPersistence.list()).map(({ header }) => ({
      sessionId: header.id, dir: sessionDirRel(header.cwd, header.id), header,
    })),
    dispose: async () => { await ctx.fiber.dispose().catch(() => undefined) },
  }
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
  const mounted = await mountSessionsBackend(options.sessionsRoot, options.installAnchor)
  try {
    const persistence = mounted.persistence
    const results: SessionValidationResult[] = []
    for (const snapshot of await persistence.list()) {
      options.signal?.throwIfAborted()
      const id = snapshot.header.id
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
        results.push({ sessionId: id, dir, header: snapshot.header, ok: true })
      } catch (error) {
        results.push({
          sessionId: id,
          dir,
          header: snapshot.header,
          ok: false,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        })
      }
    }
    return { sessionFormatVersion: mounted.sessionFormatVersion, sessions: results }
  } finally {
    await mounted.dispose()
  }
}
