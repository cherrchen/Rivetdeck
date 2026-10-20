/**
 * Acceptance coverage for session-checkpoint-restore cases that need the real
 * bundled backend or explicit fault injection (cases 1–9 of the feature's
 * Agent Note). Case 10 (honest refusal without a checkpoint) is covered by
 * `checkpoint-detect.spec.ts`; case 11 is post-v1.
 */
import { runStartupSessionMaintenance } from '../src/checkpoint/startup.ts'
import { enqueuePendingRestore, listPendingRestores } from '../src/checkpoint/pending.ts'
import { consumePendingSessionRestores, confirmIdleSessions } from '../src/checkpoint/index.ts'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs'
import { rename, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runExitCheckpoint,
  type ExitCheckpointOutcome,
  type ValidateSessions,
} from '../src/checkpoint/capture.ts'
import { detectCheckpointDrift } from '../src/checkpoint/detect.ts'
import { checkpointsRoot, readManifest, type CheckpointManifest } from '../src/checkpoint/manifest.ts'
import {
  mergeMainShutdownFacts,
  writeShutdownReportSync,
  type HostShutdownSection,
  type MainShutdownSection,
} from '../src/harness/shutdown-report.ts'
import {
  listRestoreJournals,
  writeRestoreJournal,
  type RestoreJournal,
} from '../src/checkpoint/journal.ts'
import {
  convergeRestoreJournals,
  restoreSession,
  type AcquireSessionLease,
} from '../src/checkpoint/restore.ts'
import {
  mountSessionsBackend,
  validateSessionsRoot,
} from '../src/checkpoint/validate.ts'

const roots: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-accept-'))
  roots.push(home)
  return home
}

function writeFile(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function sha(content: string | Buffer): { size: number; sha256: string } {
  return { size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
}

const CHILD_PID = 4242

async function writeCleanReport(home: string): Promise<void> {
  writeShutdownReportSync(home, {
    pid: CHILD_PID, reachedReady: true, requestedBy: 'SIGTERM', dispose: 'clean', exitCode: 0,
  })
  await mergeMainShutdownFacts(home, {
    pid: CHILD_PID, signal: 'SIGTERM', timeout: false, kill: false, exitCode: 0, signalCode: null,
  })
}

/** Validator passing every staged session dir except those in `fail`. */
function fakeValidator(fail: ReadonlySet<string> = new Set()): ValidateSessions {
  return async (root) => {
    const sessions = []
    if (existsSync(root)) {
      for (const project of readdirSync(root)) {
        for (const dir of readdirSync(join(root, project))) {
          const rel = `${project}/${dir}`
          sessions.push({ sessionId: dir, dir: rel, ok: !fail.has(rel) })
        }
      }
    }
    return { sessionFormatVersion: 4, sessions }
  }
}

/**
 * Validator that rejects `dir` on the first call only — the live bytes fail
 * while the carried verified copy passes the mixed-set re-validation.
 */
function failsOnce(dir: string): ValidateSessions {
  const reject = fakeValidator(new Set([dir]))
  const pass = fakeValidator()
  let calls = 0
  return async (root, signal) => {
    calls += 1
    return calls === 1 ? reject(root, signal) : pass(root, signal)
  }
}

/** In-process `session.lock` emulation keyed on the relative session dir. */
function fakeLeases(): { acquire: AcquireSessionLease; held: Set<string> } {
  const held = new Set<string>()
  return {
    held,
    acquire: async (member) => {
      if (held.has(member.dir)) {
        const error = new Error(`session "${member.sessionId}" is already owned`)
        error.name = 'SessionAlreadyOwnedError'
        throw error
      }
      held.add(member.dir)
      return { release: async () => { held.delete(member.dir) } }
    },
  }
}

function exitCheckpoint(home: string, id: number, validate: ValidateSessions): Promise<ExitCheckpointOutcome> {
  return runExitCheckpoint({
    home, validate, appVersion: 'test', childPid: CHILD_PID, now: () => id,
  })
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('acceptance case 1: two clean exits after pollution keep the verified copy', () => {
  it('carry-forward plus retention keeps pre-pollution bytes restorable', async () => {
    const home = makeHome()
    const sessionDir = join(home, 'sessions', '--work--', 'session-aaaa-1111')
    writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'VERIFIED')
    await writeCleanReport(home)
    const first = await exitCheckpoint(home, 1000, fakeValidator())
    expect(first.kind).toBe('committed')

    // Each exit rejects the polluted live bytes once; the carried verified
    // copy then passes the mixed-set re-validation.
    writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'POLLUTED-1')
    const second = await exitCheckpoint(home, 2000, failsOnce('--work--/session-aaaa-1111'))
    expect(second.kind).toBe('committed')
    writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'POLLUTED-2')
    const third = await exitCheckpoint(home, 3000, failsOnce('--work--/session-aaaa-1111'))
    expect(third.kind).toBe('committed')

    // Each newer checkpoint carries the verified bytes forward, so pruning the
    // first checkpoint loses nothing the session could be restored from.
    const newest = await readManifest(join(checkpointsRoot(home), '3000'))
    const entry = newest?.sessions.find(candidate => candidate.sessionId === 'session-aaaa-1111')
    expect(entry).toBeDefined()
    expect(entry?.sourceCheckpointId).toBe('1000')
    const copy = readFileSync(
      join(checkpointsRoot(home), '3000', 'sessions', '--work--', 'session-aaaa-1111', 'session.v4.jsonl.zstd'),
      'utf8',
    )
    expect(copy).toBe('VERIFIED')
  })
})

describe('acceptance case 7: bad exits never evict a good backup', () => {
  it.each<[string, { host?: Partial<HostShutdownSection>; main?: Partial<MainShutdownSection> }]>([
    ['dispose failed', { host: { dispose: 'failed' } }],
    ['drain timeout', { host: { dispose: 'timeout' } }],
    ['killed host', { main: { kill: true, signalCode: 'SIGKILL' } }],
    ['boot failure', { host: { reachedReady: false } }],
  ])('%s leaves the committed checkpoint untouched', async (_label, overrides) => {
    const home = makeHome()
    const sessionDir = join(home, 'sessions', '--work--', 'session-aaaa-1111')
    writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'VERIFIED')
    await writeCleanReport(home)
    expect((await exitCheckpoint(home, 1000, fakeValidator())).kind).toBe('committed')
    const before = readFileSync(join(checkpointsRoot(home), '1000', 'manifest.json'), 'utf8')

    writeShutdownReportSync(home, {
      pid: CHILD_PID, reachedReady: true, requestedBy: 'SIGTERM', dispose: 'clean', exitCode: 0,
      ...overrides.host,
    })
    await mergeMainShutdownFacts(home, {
      pid: CHILD_PID, signal: 'SIGTERM', timeout: false, kill: false, exitCode: 0, signalCode: null,
      ...overrides.main,
    })
    const outcome = await exitCheckpoint(home, 2000, fakeValidator())
    expect(outcome.kind).toBe('skipped')
    expect(readFileSync(join(checkpointsRoot(home), '1000', 'manifest.json'), 'utf8')).toBe(before)
    expect(readdirSync(checkpointsRoot(home)).filter(name => !name.endsWith('.tmp'))).toEqual(['1000'])
  })
})

const CASE4_DIR = '--work-p--/session-parent-1'
const CASE4_HEADER = { id: 'session-parent-1', cwd: '/work/p', isSeeded: false, delegationDepth: 0 }

describe('acceptance case 4: interruption at each switch stage converges at next startup', () => {
  function seed(home: string): void {
    writeFile(join(home, 'sessions', CASE4_DIR, 'session.v4.jsonl.zstd'), 'POLLUTED')
    writeFile(join(home, 'sessions', CASE4_DIR, 'session.lock'), '')
    const dir = join(checkpointsRoot(home), '1000')
    writeFile(join(dir, 'sessions', CASE4_DIR, 'session.v4.jsonl.zstd'), 'VERIFIED')
    writeFile(join(dir, 'manifest.json'), JSON.stringify({
      version: 1, id: '1000', capturedAt: 1000, shutdown: { version: 1, recordedAt: 0 },
      files: [{ path: `sessions/${CASE4_DIR}/session.v4.jsonl.zstd`, origin: 'captured', digest: sha('VERIFIED') }],
      sessions: [{
        sessionId: 'session-parent-1', dir: CASE4_DIR, header: CASE4_HEADER,
        capturedAt: 1000, sourceCheckpointId: '1000',
        validator: { appVersion: 'old', sessionFormatVersion: 4 },
      }],
    } satisfies CheckpointManifest))
  }

  async function seedJournal(home: string): Promise<void> {
    const liveStat = await stat(join(home, 'sessions', CASE4_DIR, 'session.v4.jsonl.zstd'), { bigint: true })
    const journal: RestoreJournal = {
      version: 1,
      id: '8000-session-parent-1',
      phase: 'intent',
      checkpointId: '1000',
      targetSessionId: 'session-parent-1',
      createdAt: 8000,
      updatedAt: 8000,
      quarantine: 'electron/quarantine/8000-session-parent-1',
      members: [{
        sessionId: 'session-parent-1',
        dir: CASE4_DIR,
        header: CASE4_HEADER,
        liveFiles: [{ name: 'session.v4.jsonl.zstd', size: Number(liveStat.size), mtimeNs: String(liveStat.mtimeNs) }],
        publish: [{ name: 'session.v4.jsonl.zstd', digest: sha('VERIFIED') }],
      }],
    }
    await writeRestoreJournal(home, journal)
  }

  for (const throws of [false, true]) {
    it(`gates a journal created by this launch's restore (${throws ? 'notification throws' : 'failed result'})`, async () => {
      const home = makeHome()
      seed(home)
      const blockedRow = join(home, 'storages', 'session_projcache', 'sessions', 'session-parent-1.json')
      writeFile(join(blockedRow, 'blocker'), 'keeps cache removal from completing')
      const errors: unknown[] = []
      const deferred: string[] = []
      const allowed = await runStartupSessionMaintenance({
        home,
        gate: async () => {
          const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
          deferred.push(...result.deferred)
          return result.deferred.length === 0
        },
        maintain: async () => {
          const outcome = await restoreSession({
            home, sessionId: 'session-parent-1', acquireLease: fakeLeases().acquire, validate: fakeValidator(),
          })
          expect(outcome.kind).toBe('failed')
          expect(readFileSync(join(home, 'sessions', CASE4_DIR, 'session.v4.jsonl.zstd'), 'utf8')).toBe('VERIFIED')
          if (throws) throw new Error('notification failed')
        },
        onError: error => errors.push(error),
      })
      expect(allowed).toBe(false)
      expect(deferred).toHaveLength(1)
      expect(errors).toHaveLength(throws ? 1 : 0)
      expect(await listRestoreJournals(home)).toHaveLength(1)
      rmSync(blockedRow, { recursive: true })
      const resumed = await runStartupSessionMaintenance({
        home,
        gate: async () => (await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })).deferred.length === 0,
        maintain: async () => {}, onError: (error) => { throw error },
      })
      expect(resumed).toBe(true)
      expect(await listRestoreJournals(home)).toEqual([])
    })
  }

  it('resumes when only staging completed (tmp staged, live untouched)', async () => {
    const home = makeHome()
    seed(home)
    await seedJournal(home)
    // Crash after staging: the tmp sibling is complete on disk.
    writeFile(join(home, 'sessions', CASE4_DIR, 'session.v4.jsonl.zstd.restore.tmp'), 'VERIFIED')
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result).toEqual({ converged: ['8000-session-parent-1'], conflicted: [], deferred: [], unresolvable: [] })
    const liveDir = join(home, 'sessions', CASE4_DIR)
    expect(readFileSync(join(liveDir, 'session.v4.jsonl.zstd'), 'utf8')).toBe('VERIFIED')
    expect(existsSync(join(liveDir, 'session.v4.jsonl.zstd.restore.tmp'))).toBe(false)
    expect(readFileSync(
      join(home, 'electron', 'quarantine', '8000-session-parent-1', 'sessions', CASE4_DIR, 'session.v4.jsonl.zstd'),
      'utf8',
    )).toBe('POLLUTED')
    expect(await listRestoreJournals(home)).toEqual([])
  })

  it('resumes when quarantine finished but publish never ran (canonical gap)', async () => {
    const home = makeHome()
    seed(home)
    await seedJournal(home)
    const liveDir = join(home, 'sessions', CASE4_DIR)
    // Crash mid-switch: live file already quarantined, canonical name absent,
    // staged tmp synced but not yet renamed.
    const quarantined = join(
      home, 'electron', 'quarantine', '8000-session-parent-1', 'sessions', CASE4_DIR,
    )
    mkdirSync(quarantined, { recursive: true })
    await rename(join(liveDir, 'session.v4.jsonl.zstd'), join(quarantined, 'session.v4.jsonl.zstd'))
    writeFile(join(liveDir, 'session.v4.jsonl.zstd.restore.tmp'), 'VERIFIED')
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result.converged).toEqual(['8000-session-parent-1'])
    expect(readFileSync(join(liveDir, 'session.v4.jsonl.zstd'), 'utf8')).toBe('VERIFIED')
    expect(await listRestoreJournals(home)).toEqual([])
  })
})

// --- Real bundled backend -------------------------------------------------

const APP_PATH = fileURLToPath(new URL('..', import.meta.url))
const INSTALL_ANCHOR = join(APP_PATH, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
// Production resolution re-anchors at the base bundle, which declares the
// backend in its production dependency set (see backendRequire in validate.ts).
const BACKEND_ANCHOR = existsSync(INSTALL_ANCHOR)
  ? createRequire(INSTALL_ANCHOR).resolve('@deepseek-ai/dsh-base/package.json')
  : INSTALL_ANCHOR
const backendAvailable = existsSync(INSTALL_ANCHOR)
  && existsSync(join(fileURLToPath(new URL('../../..', import.meta.url)), 'packages', 'session', 'session-persistence-jsonl', 'lib', 'index.js'))

interface RealSession {
  readonly id: string
  readonly dir: string
  readonly header: CheckpointManifest['sessions'][number]['header'] & Record<string, unknown>
}

/** Create one real session through the bundled backend write path. */
async function createRealSession(home: string, id: string, cwd: string): Promise<RealSession> {
  const req = createRequire(BACKEND_ANCHOR)
  const backend = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href) as {
    default: unknown
  }
  const cordis = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href) as {
    Context: new () => {
      plugin(plugin: unknown, config: unknown): Promise<unknown>
      sessionPersistence: {
        create(header: Record<string, unknown>): Promise<{
          append(events: readonly Record<string, unknown>[]): Promise<void>
          flush(): Promise<void>
          close(): Promise<void>
        }>
      }
      fiber: { dispose(): Promise<void> }
    }
  }
  const session = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session')).href) as {
    SESSION_FORMAT_VERSION: number
    SessionId(id: string): unknown
  }
  const ctx = new cordis.Context()
  await ctx.plugin(backend.default, { root: join(home, 'sessions'), compression: 'zstd' })
  const handle = await ctx.sessionPersistence.create({
    version: session.SESSION_FORMAT_VERSION,
    id: session.SessionId(id),
    createdAt: 1,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  })
  await handle.append([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  await handle.flush()
  await handle.close()
  await ctx.fiber.dispose()
  const sessionsRoot = join(home, 'sessions')
  const project = readdirSync(sessionsRoot)[0]!
  const dir = `${project}/${id}`
  expect(existsSync(join(sessionsRoot, dir, 'session.v4.jsonl.zstd'))).toBe(true)
  return {
    id,
    dir,
    header: {
      version: session.SESSION_FORMAT_VERSION, id, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0,
    },
  }
}

/** Build a committed checkpoint whose session bytes equal the live ones. */
function checkpointFromLive(home: string, session: RealSession, checkpointId: string): void {
  const liveDir = join(home, 'sessions', session.dir)
  const dir = join(checkpointsRoot(home), checkpointId)
  const files: CheckpointManifest['files'][number][] = []
  for (const name of readdirSync(liveDir)) {
    if (name === 'session.lock' || name.endsWith('.tmp')) continue
    const bytes = readFileSync(join(liveDir, name))
    writeFile(join(dir, 'sessions', session.dir, name), bytes)
    files.push({ path: `sessions/${session.dir}/${name}`, origin: 'captured', digest: sha(bytes) })
  }
  const manifest: CheckpointManifest = {
    version: 1, id: checkpointId, capturedAt: Number(checkpointId), shutdown: { version: 1, recordedAt: 0 },
    files,
    sessions: [{
      sessionId: session.id, dir: session.dir, header: session.header,
      capturedAt: Number(checkpointId), sourceCheckpointId: checkpointId,
      validator: { appVersion: 'test', sessionFormatVersion: 4 },
    }],
  }
  writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
}

/**
 * Append one required event of an unknown type as a new Zstandard frame. The
 * on-disk layout keeps the header alone in the first frame, so splicing the
 * event into the decoded lines would corrupt the log instead of producing an
 * event-admission refusal.
 */
function polluteWithUnknownEvent(home: string, dir: string): void {
  const event = `${JSON.stringify({ type: 'acceptance/foreign-write', seq: 2, time: 3, data: {} })}\n`
  appendFileSync(join(home, 'sessions', dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(event)))
}

/** Publish a well-formed v9 successor the bundled build cannot read. */
function polluteWithNewerGeneration(home: string, dir: string): void {
  const v4 = join(home, 'sessions', dir, 'session.v4.jsonl.zstd')
  const raw = zstdDecompressSync(readFileSync(v4)).toString()
  const lines = raw.split('\n')
  const header = JSON.parse(lines[0]!) as { version: number }
  header.version = 9
  lines[0] = JSON.stringify(header)
  writeFile(join(home, 'sessions', dir, 'session.v9.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.join('\n'))))
}

function realLeases(home: string): { acquire: AcquireSessionLease; close(): Promise<void> } {
  let mounted: Awaited<ReturnType<typeof mountSessionsBackend>> | undefined
  return {
    acquire: async (member) => {
      mounted ??= await mountSessionsBackend(join(home, 'sessions'), INSTALL_ANCHOR)
      return mounted.persistence.acquireWriteLease(member.header)
    },
    close: async () => { await mounted?.dispose() },
  }
}

/** Drain one session's events through the real read path; resolves false on refusal. */
async function readOpens(home: string, id: string): Promise<boolean> {
  const mounted = await mountSessionsBackend(join(home, 'sessions'), INSTALL_ANCHOR)
  try {
    const handle = await mounted.persistence.open(id, 'read')
    try {
      for (let offset = 0; ;) {
        const page = await handle.read(offset)
        if (page.events.length === 0) break
        offset = page.events[page.events.length - 1]!.seq + 1
      }
      return true
    } finally {
      await handle.close()
    }
  } catch {
    return false
  } finally {
    await mounted.dispose()
  }
}

describe('acceptance case 2/6: real lease competition (bundled flock)', () => {
  it.skipIf(!backendAvailable)('a live writer lease rejects a competing acquire and release reopens it', async () => {
    const home = makeHome()
    const session = await createRealSession(home, 'lease-target', '/work/lease')
    const mounted = await mountSessionsBackend(join(home, 'sessions'), INSTALL_ANCHOR)
    const lease = await mounted.persistence.acquireWriteLease(session.header)
    await expect(mounted.persistence.acquireWriteLease(session.header)).rejects.toMatchObject({
      name: 'SessionAlreadyOwnedError',
    })
    await lease.release()
    const again = await mounted.persistence.acquireWriteLease(session.header)
    await again.release()
    await mounted.dispose()
  })

  it('a held lease refuses restore and leaves live bytes in place', async () => {
    const home = makeHome()
    const sessionDir = '--work-p--/session-x'
    writeFile(join(home, 'sessions', sessionDir, 'session.v4.jsonl.zstd'), 'LIVE')
    writeFile(join(home, 'sessions', sessionDir, 'session.lock'), '')
    const dir = join(checkpointsRoot(home), '1000')
    writeFile(join(dir, 'sessions', sessionDir, 'session.v4.jsonl.zstd'), 'VERIFIED')
    writeFile(join(dir, 'manifest.json'), JSON.stringify({
      version: 1, id: '1000', capturedAt: 1000, shutdown: { version: 1, recordedAt: 0 },
      files: [{ path: `sessions/${sessionDir}/session.v4.jsonl.zstd`, origin: 'captured', digest: sha('VERIFIED') }],
      sessions: [{
        sessionId: 'session-x', dir: sessionDir,
        header: { id: 'session-x', cwd: '/work/p', isSeeded: false, delegationDepth: 0 },
        capturedAt: 1000, sourceCheckpointId: '1000',
        validator: { appVersion: 'old', sessionFormatVersion: 4 },
      }],
    } satisfies CheckpointManifest))
    const leases = fakeLeases()
    leases.held.add(sessionDir)
    const outcome = await restoreSession({
      home, sessionId: 'session-x', acquireLease: leases.acquire, validate: fakeValidator(),
    })
    expect(outcome.kind).toBe('refused')
    expect(readFileSync(join(home, 'sessions', sessionDir, 'session.v4.jsonl.zstd'), 'utf8')).toBe('LIVE')
  })
})

describe('acceptance case 3: read-open settles at every switch stage', () => {
  it.skipIf(!backendAvailable)('open completes or fails fast mid-switch, and succeeds after publish', async () => {
    const home = makeHome()
    const session = await createRealSession(home, 'switch-stages', '/work/stages')
    const liveDir = join(home, 'sessions', session.dir)
    const canonical = join(liveDir, 'session.v4.jsonl.zstd')

    // Stage 1 — intent only: live bytes still the foreign successor.
    polluteWithNewerGeneration(home, session.dir)
    expect(await readOpens(home, session.id)).toBe(false)

    // Stage 2 — staged tmp synced, live canonical still polluted.
    writeFile(join(liveDir, 'session.v4.jsonl.zstd.restore.tmp'), readFileSync(canonical))
    expect(await readOpens(home, session.id)).toBe(false)

    // Stage 3 — canonical files moved to quarantine: the canonical gap.
    rmSync(join(liveDir, 'session.v9.jsonl.zstd'))
    const quarantine = join(home, 'electron', 'quarantine', 'probe', 'sessions', session.dir)
    mkdirSync(quarantine, { recursive: true })
    await rename(canonical, join(quarantine, 'session.v4.jsonl.zstd'))
    expect(await readOpens(home, session.id)).toBe(false)

    // Stage 4 — canonical published: open drains the checkpoint bytes.
    await rename(join(liveDir, 'session.v4.jsonl.zstd.restore.tmp'), canonical)
    expect(await readOpens(home, session.id)).toBe(true)
  })
})

describe('acceptance case 8: unknown-event and vN pollution restore cleanly', () => {
  for (const [label, pollute, expectListedUnreadable] of [
    ['unknown required event', polluteWithUnknownEvent, true],
    ['newer generation file', polluteWithNewerGeneration, false],
  ] as const) {
    it.skipIf(!backendAvailable)(`restores a session polluted by ${label} and reopens it`, async () => {
      const home = makeHome()
      const session = await createRealSession(home, `case8-${label.slice(0, 4)}`, '/work/case8')
      checkpointFromLive(home, session, '1000')
      pollute(home, session.dir)

      // The bundled read path must actually refuse the live bytes.
      const report = await validateSessionsRoot({ sessionsRoot: join(home, 'sessions'), installAnchor: INSTALL_ANCHOR })
      const liveEntry = report.sessions.find(candidate => candidate.dir === session.dir)
      if (expectListedUnreadable) {
        expect(liveEntry?.ok).toBe(false)
      } else {
        expect(liveEntry === undefined || !liveEntry.ok).toBe(true)
      }

      const leases = realLeases(home)
      try {
        const outcome = await restoreSession({
          home, sessionId: session.id,
          acquireLease: leases.acquire,
          validate: (root, signal) => validateSessionsRoot({ sessionsRoot: root, installAnchor: INSTALL_ANCHOR, signal }),
        })
        expect(outcome.kind).toBe('restored')
      } finally {
        await leases.close()
      }

      expect(await readOpens(home, session.id)).toBe(true)
      expect(existsSync(join(home, 'sessions', session.dir, 'session.v9.jsonl.zstd'))).toBe(false)
    })
  }
})

describe('acceptance case 9: both branches survive restore + later writes + swap-back', () => {
  it.skipIf(!backendAvailable)('keeps the restored branch and the quarantined branch on disk', async () => {
    const home = makeHome()
    const session = await createRealSession(home, 'branch-keep', '/work/branches')
    checkpointFromLive(home, session, '1000')
    polluteWithNewerGeneration(home, session.dir)
    const pollutedV9 = readFileSync(join(home, 'sessions', session.dir, 'session.v9.jsonl.zstd'))

    const leases = realLeases(home)
    try {
      const outcome = await restoreSession({
        home, sessionId: session.id,
        acquireLease: leases.acquire,
        validate: (root, signal) => validateSessionsRoot({ sessionsRoot: root, installAnchor: INSTALL_ANCHOR, signal }),
      })
      expect(outcome.kind).toBe('restored')
    } finally {
      await leases.close()
    }

    // Write a new turn onto the restored v4 branch through the real write path.
    const mounted = await mountSessionsBackend(join(home, 'sessions'), INSTALL_ANCHOR)
    try {
      const handle = await mounted.persistence.open(session.id, 'write')
      try {
        await handle.append([{ type: 'turn/start', seq: 2, time: 10, data: { turn: 2 } }])
        await handle.flush()
      } finally {
        await handle.close()
      }
    } finally {
      await mounted.dispose()
    }
    const liveDir = join(home, 'sessions', session.dir)
    const appendedBranch = readFileSync(join(liveDir, 'session.v4.jsonl.zstd'))

    // Swap the quarantined foreign log back over the canonical name; both
    // byte sets remain on disk.
    const restoredCopy = join(liveDir, 'session.v4.restored-branch')
    renameSync(join(liveDir, 'session.v4.jsonl.zstd'), restoredCopy)
    const quarantineDir = readdirSync(join(home, 'electron', 'quarantine'))[0]!
    copyFileSync(
      join(home, 'electron', 'quarantine', quarantineDir, 'sessions', session.dir, 'session.v9.jsonl.zstd'),
      join(liveDir, 'session.v9.jsonl.zstd'),
    )
    expect(readFileSync(restoredCopy)).toEqual(appendedBranch)
    expect(readFileSync(join(liveDir, 'session.v9.jsonl.zstd'))).toEqual(pollutedV9)
    expect(existsSync(join(home, 'electron', 'quarantine', quarantineDir, 'sessions', session.dir, 'session.v9.jsonl.zstd'))).toBe(true)
  })
})

describe('capture and detection through the bundled backend', () => {
  it.skipIf(!backendAvailable)('keeps a carried pollution candidate detectable until restore', async () => {
    const home = makeHome()
    const session = await createRealSession(home, 'carried-detection', '/work/carried')
    await writeCleanReport(home)
    const validate: ValidateSessions = (root, signal) => validateSessionsRoot({ sessionsRoot: root, installAnchor: INSTALL_ANCHOR, signal })
    expect((await exitCheckpoint(home, 1000, validate)).kind).toBe('committed')
    polluteWithUnknownEvent(home, session.dir)
    expect((await exitCheckpoint(home, 2000, validate)).kind).toBe('committed')
    expect((await detectCheckpointDrift(home, { formatVersion: 4 }))?.candidates.map(item => item.sessionId))
      .toEqual([session.id])
    const leases = realLeases(home)
    try {
      expect((await restoreSession({ home, sessionId: session.id, acquireLease: leases.acquire, validate })).kind).toBe('restored')
    } finally { await leases.close() }
    expect((await detectCheckpointDrift(home, { formatVersion: 4 }))?.candidates).toEqual([])
  })

  it.skipIf(!backendAvailable)('refuses to commit a carried future header omitted by the current reader', async () => {
    const home = makeHome()
    const session = await createRealSession(home, 'future-carried', '/work/downgrade')
    polluteWithNewerGeneration(home, session.dir)
    checkpointFromLive(home, session, '1000')
    await writeCleanReport(home)
    const outcome = await exitCheckpoint(home, 2000, (root, signal) =>
      validateSessionsRoot({ sessionsRoot: root, installAnchor: INSTALL_ANCHOR, signal }))
    expect(outcome).toMatchObject({ kind: 'aborted' })
    expect(readdirSync(checkpointsRoot(home))).toEqual(['1000'])
  })

  it.skipIf(!backendAvailable)('validates live bytes only after acquiring the real write lease', async () => {
    const home = makeHome()
    const session = await createRealSession(home, 'leased-detection', '/work/detection')
    await writeCleanReport(home)
    expect((await exitCheckpoint(home, 1000, root =>
      validateSessionsRoot({ sessionsRoot: root, installAnchor: INSTALL_ANCHOR }))).kind).toBe('committed')
    const canonical = join(home, 'sessions', session.dir, 'session.v4.jsonl.zstd')
    const before = readFileSync(canonical)
    polluteWithUnknownEvent(home, session.dir)
    const detection = await detectCheckpointDrift(home, { formatVersion: 4 })
    expect(detection?.candidates).toHaveLength(1)
    const mounted = await mountSessionsBackend(join(home, 'sessions'), INSTALL_ANCHOR)
    try {
      const kept = await confirmIdleSessions(detection!, async (member) => {
        // A foreign append has rolled back before releasing its lease.
        writeFileSync(canonical, before)
        return mounted.persistence.acquireWriteLease(member.header)
      }, async () => {
        await expect(mounted.persistence.acquireWriteLease(session.header)).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
        return validateSessionsRoot({ sessionsRoot: join(home, 'sessions'), installAnchor: INSTALL_ANCHOR })
      })
      expect(kept).toEqual([])
      const again = await mounted.persistence.acquireWriteLease(session.header)
      await again.release()
    } finally { await mounted.dispose() }
  })

  it.skipIf(!backendAvailable)('does not replay a completed queued rollback over later session writes', async () => {
    const home = makeHome()
    const session = await createRealSession(home, 'acknowledged-request', '/work/ack')
    checkpointFromLive(home, session, '1000')
    polluteWithUnknownEvent(home, session.dir)
    await enqueuePendingRestore(home, session.id, '1000')
    const request = (await listPendingRestores(home))[0]!
    const leases = realLeases(home)
    try {
      expect((await restoreSession({
        home, sessionId: session.id, checkpointId: '1000', pendingRequestId: request.id,
        acquireLease: leases.acquire,
        validate: root => validateSessionsRoot({ sessionsRoot: root, installAnchor: INSTALL_ANCHOR }),
      })).kind).toBe('restored')
    } finally { await leases.close() }
    expect(await listPendingRestores(home)).toEqual([])
    const mounted = await mountSessionsBackend(join(home, 'sessions'), INSTALL_ANCHOR)
    try {
      const handle = await mounted.persistence.open(session.id, 'write')
      try { await handle.append([{ type: 'turn/start', seq: 2, time: 10, data: { turn: 2 } }]); await handle.flush() }
      finally { await handle.close() }
    } finally { await mounted.dispose() }
    const path = join(home, 'sessions', session.dir, 'session.v4.jsonl.zstd')
    const appended = readFileSync(path)
    expect(await consumePendingSessionRestores({
      home, appPath: APP_PATH, resourcesPath: APP_PATH, packaged: false,
      hostRuntime: { executable: process.execPath, env: {} }, hostRunning: () => false,
    })).toEqual([])
    expect(readFileSync(path)).toEqual(appended)
  })
})

describe('confirmed checkpoint identity', () => {
  it.skipIf(!backendAvailable)('restores the queued checkpoint after later exit captures and retention', async () => {
    const home = makeHome()
    const session = await createRealSession(home, 'pinned-target', '/work/pinned')
    checkpointFromLive(home, session, '1000')
    const canonical = join(home, 'sessions', session.dir, 'session.v4.jsonl.zstd')
    const confirmed = readFileSync(canonical)
    await enqueuePendingRestore(home, session.id, '1000')
    const mounted = await mountSessionsBackend(join(home, 'sessions'), INSTALL_ANCHOR)
    try {
      const handle = await mounted.persistence.open(session.id, 'write')
      try {
        await handle.append([{ type: 'turn/start', seq: 2, time: 10, data: { turn: 2 } }])
        await handle.flush()
      } finally { await handle.close() }
    } finally { await mounted.dispose() }
    await writeCleanReport(home)
    for (const id of [2000, 3000, 4000, 5000]) {
      expect((await exitCheckpoint(home, id, (root, signal) =>
        validateSessionsRoot({ sessionsRoot: root, installAnchor: INSTALL_ANCHOR, signal }))).kind).toBe('committed')
    }
    expect(readFileSync(canonical)).not.toEqual(confirmed)
    expect(existsSync(join(checkpointsRoot(home), '1000'))).toBe(true)
    const options = {
      home, appPath: APP_PATH, resourcesPath: APP_PATH, packaged: false,
      hostRuntime: { executable: process.execPath, env: {} }, hostRunning: () => false,
    }
    expect(await consumePendingSessionRestores(options)).toMatchObject([
      { sessionId: session.id, outcome: { kind: 'restored', checkpointId: '1000' } },
    ])
    expect(readFileSync(canonical)).toEqual(confirmed)
    expect(await listPendingRestores(home)).toEqual([])
    await enqueuePendingRestore(home, session.id, 'missing')
    expect(await consumePendingSessionRestores(options)).toMatchObject([
      { outcome: { kind: 'refused', reason: { key: 'no-checkpoint' } } },
    ])
    expect(readFileSync(canonical)).toEqual(confirmed)
    writeFile(join(home, 'electron', 'pending-restore.json'), JSON.stringify({
      version: 1, requests: [{ sessionId: session.id, requestedAt: 1 }],
    }))
    expect(await consumePendingSessionRestores(options)).toMatchObject([
      { outcome: { kind: 'refused', reason: { key: 'no-checkpoint' } } },
    ])
    expect(readFileSync(canonical)).toEqual(confirmed)
  })
})
