import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listRestoreJournals,
  readRestoreJournal,
  restoreJournalsDir,
  writeRestoreJournal,
  type RestoreJournal,
} from '../src/checkpoint/journal.ts'
import { checkpointsRoot, type CheckpointManifest, type CheckpointSessionHeader } from '../src/checkpoint/manifest.ts'
import {
  convergeRestoreJournals,
  restoreSession,
  type AcquireSessionLease,
} from '../src/checkpoint/restore.ts'
import type { ValidateSessions } from '../src/checkpoint/capture.ts'

const roots: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-restore-'))
  roots.push(home)
  return home
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

function sha(content: string): { size: number; sha256: string } {
  return { size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
}

const PARENT: CheckpointSessionHeader = { id: 'session-parent-1', cwd: '/work/p', isSeeded: false, delegationDepth: 0 }
const CHILD: CheckpointSessionHeader = {
  id: 'session-child-1', cwd: '/work/p', isSeeded: false, delegationDepth: 1,
  origin: 'subagent', parentSession: 'session-parent-1',
}

interface SeedSession {
  sessionId: string
  dir: string
  header: CheckpointSessionHeader
  files: Record<string, string>
}

/** Commit a checkpoint holding the given session dirs/files with headers. */
function seedCheckpoint(home: string, id: string, sessions: SeedSession[]): void {
  const dir = join(checkpointsRoot(home), id)
  const manifest: CheckpointManifest = {
    version: 1,
    id,
    capturedAt: Number(id),
    shutdown: { version: 1, recordedAt: Number(id) },
    files: sessions.flatMap(session => Object.entries(session.files).map(([name, bytes]) => ({
      path: `sessions/${session.dir}/${name}`,
      origin: 'captured' as const,
      digest: sha(bytes),
    }))),
    sessions: sessions.map(session => ({
      sessionId: session.sessionId,
      dir: session.dir,
      header: session.header,
      capturedAt: Number(id),
      sourceCheckpointId: id,
      validator: { appVersion: '0.2.0', sessionFormatVersion: 4 },
    })),
  }
  for (const session of sessions) {
    for (const [name, bytes] of Object.entries(session.files)) {
      writeFile(join(dir, 'sessions', session.dir, name), bytes)
    }
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
}

/** Validator reporting every listed session dir as ok (or per `fail`). */
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

/** In-process `session.lock` emulation: contention throws the backend's error name. */
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

const SESSION_DIR = '--work-p--/session-parent-1'
const CHILD_DIR = '--work-p--/session-child-1'

function liveSession(home: string, dir: string, files: Record<string, string>): void {
  for (const [name, bytes] of Object.entries(files)) {
    writeFile(join(home, 'sessions', dir, name), bytes)
  }
  writeFile(join(home, 'sessions', dir, 'session.lock'), '')
}

function projcacheRow(home: string, sessionId: string): string {
  const path = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  writeFile(path, '{}')
  return path
}

function restore(home: string, sessionId: string, extra: Partial<Parameters<typeof restoreSession>[0]> = {}) {
  const leases = fakeLeases()
  return {
    leases,
    run: restoreSession({
      home, sessionId, acquireLease: leases.acquire, validate: fakeValidator(), now: () => 9000, ...extra,
    }),
  }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('restoreSession', () => {
  it('replaces live files with verified checkpoint bytes and invalidates projcache', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.jsonl.zstd': 'OLD', 'session.v4.jsonl.zstd': 'POLLUTED' })
    const row = projcacheRow(home, 'session-parent-1')
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.jsonl.zstd': 'OLD', 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    const { run, leases } = restore(home, 'session-parent-1')
    const outcome = await run
    expect(outcome).toMatchObject({ kind: 'restored', checkpointId: '1000', sessions: ['session-parent-1'] })
    const liveDir = join(home, 'sessions', SESSION_DIR)
    expect(read(join(liveDir, 'session.v4.jsonl.zstd'))).toBe('VERIFIED')
    expect(read(join(liveDir, 'session.jsonl.zstd'))).toBe('OLD')
    expect(existsSync(join(liveDir, 'session.lock'))).toBe(true)
    expect(read(join(home, 'electron', 'quarantine', '9000-session-parent-1', 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('POLLUTED')
    expect(existsSync(row)).toBe(false)
    expect(await listRestoreJournals(home)).toEqual([])
    expect(leases.held.size).toBe(0)
  })

  it('restores the related-source closure: subagent children switch and invalidate too', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    liveSession(home, CHILD_DIR, { 'session.v4.jsonl.zstd': 'CHILD-LIVE' })
    const childRow = projcacheRow(home, 'session-child-1')
    seedCheckpoint(home, '1000', [
      { sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT, files: { 'session.v4.jsonl.zstd': 'VERIFIED' } },
      { sessionId: 'session-child-1', dir: CHILD_DIR, header: CHILD, files: { 'session.v4.jsonl.zstd': 'CHILD-VERIFIED' } },
    ])
    const { run } = restore(home, 'session-parent-1')
    const outcome = await run
    expect(outcome).toMatchObject({ kind: 'restored', sessions: ['session-parent-1', 'session-child-1'] })
    expect(read(join(home, 'sessions', CHILD_DIR, 'session.v4.jsonl.zstd'))).toBe('CHILD-VERIFIED')
    expect(existsSync(childRow)).toBe(false)
    expect(existsSync(join(home, 'electron', 'quarantine', '9000-session-parent-1', 'sessions', CHILD_DIR, 'session.v4.jsonl.zstd'))).toBe(true)
  })

  it('refuses a session with no verified checkpoint copy and leaves live data in place', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'LIVE' })
    const outcome = await restore(home, 'session-parent-1').run
    expect(outcome).toMatchObject({ kind: 'refused' })
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('LIVE')
    expect(await listRestoreJournals(home)).toEqual([])
  })

  it('refuses while the write lease is held by a live writer', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'LIVE' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    const { run, leases } = restore(home, 'session-parent-1')
    leases.held.add(SESSION_DIR)
    const outcome = await run
    expect(outcome).toMatchObject({ kind: 'refused' })
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('LIVE')
    expect(await listRestoreJournals(home)).toEqual([])
  })

  it('refuses while the local Host is up', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'LIVE' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    const outcome = await restore(home, 'session-parent-1', { hostRunning: () => true }).run
    expect(outcome).toMatchObject({ kind: 'refused', reason: { key: 'host-running' } })
  })

  it('refuses a checkpoint whose manifest lacks related-source headers', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'LIVE' })
    const dir = join(checkpointsRoot(home), '1000')
    writeFile(join(dir, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'), 'VERIFIED')
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      version: 1, id: '1000', capturedAt: 1000, shutdown: { version: 1, recordedAt: 0 },
      files: [{ path: `sessions/${SESSION_DIR}/session.v4.jsonl.zstd`, origin: 'captured', digest: sha('VERIFIED') }],
      sessions: [{
        sessionId: 'session-parent-1', dir: SESSION_DIR, capturedAt: 1000,
        sourceCheckpointId: '1000', validator: { appVersion: 'old', sessionFormatVersion: 4 },
      }],
    }))
    const outcome = await restore(home, 'session-parent-1').run
    expect(outcome).toMatchObject({ kind: 'refused', reason: { key: 'incomplete-headers' } })
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('LIVE')
  })

  it('refuses when the checkpoint bytes no longer pass the current build', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'LIVE' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    const outcome = await restoreSession({
      home, sessionId: 'session-parent-1', acquireLease: fakeLeases().acquire,
      validate: fakeValidator(new Set([SESSION_DIR])),
    })
    expect(outcome).toMatchObject({ kind: 'refused', reason: { key: 'revalidation-failed', dirs: [SESSION_DIR] } })
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('LIVE')
  })

  it('removes a live generation absent from the checkpoint (hiding pollution)', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, {
      'session.v4.jsonl.zstd': 'CLEAN-OLD', 'session.v5.jsonl.zstd': 'FOREIGN-GEN',
    })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    const outcome = await restore(home, 'session-parent-1').run
    expect(outcome).toMatchObject({ kind: 'restored' })
    const liveDir = join(home, 'sessions', SESSION_DIR)
    expect(existsSync(join(liveDir, 'session.v5.jsonl.zstd'))).toBe(false)
    expect(read(join(home, 'electron', 'quarantine', '9000-session-parent-1', 'sessions', SESSION_DIR, 'session.v5.jsonl.zstd'))).toBe('FOREIGN-GEN')
    expect(read(join(liveDir, 'session.v4.jsonl.zstd'))).toBe('VERIFIED')
  })

  it('keeps journal, quarantine, and projcache paths inside the home when the session id is hostile', async () => {
    const home = makeHome()
    const hostile = 'evil/../../x'
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    // Without the safe-key guard the row rm resolves to this planted file.
    writeFile(join(home, 'storages', 'session_projcache', 'x.json'), '{}')
    seedCheckpoint(home, '1000', [{
      sessionId: hostile, dir: SESSION_DIR, header: { ...PARENT, id: hostile },
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    const outcome = await restore(home, hostile).run
    expect(outcome).toMatchObject({ kind: 'restored', quarantine: 'electron/quarantine/9000-session-parent-1' })
    expect(read(join(home, 'electron', 'quarantine', '9000-session-parent-1', 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('POLLUTED')
    expect(existsSync(join(home, 'electron', 'x'))).toBe(false)
    expect(existsSync(join(home, 'storages', 'session_projcache', 'x.json'))).toBe(true)
  })

  it('fails a manifest whose session dir would escape the sessions root', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'LIVE' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: '../escape', header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    const outcome = await restore(home, 'session-parent-1', {
      validate: async () => ({
        sessionFormatVersion: 4,
        sessions: [{ sessionId: 'session-parent-1', dir: '../escape', ok: true }],
      }),
    }).run
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.reason).toContain('unsafe session dir')
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('LIVE')
    expect(existsSync(join(home, 'escape'))).toBe(false)
  })
})

describe('convergeRestoreJournals', () => {
  async function seedIntentJournal(home: string, overrides: Partial<RestoreJournal> = {}): Promise<RestoreJournal> {
    const liveStat = await stat(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'), { bigint: true })
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
        dir: SESSION_DIR,
        header: PARENT,
        liveFiles: [{ name: 'session.v4.jsonl.zstd', size: Number(liveStat.size), mtimeNs: String(liveStat.mtimeNs) }],
        publish: [{ name: 'session.v4.jsonl.zstd', digest: sha('VERIFIED') }],
      }],
      ...overrides,
    }
    await writeRestoreJournal(home, journal)
    return journal
  }

  it('finishes an intent journal left before any staging', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    const row = projcacheRow(home, 'session-parent-1')
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    await seedIntentJournal(home)
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result).toEqual({ converged: ['8000-session-parent-1'], conflicted: [], deferred: [] })
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('VERIFIED')
    expect(read(join(home, 'electron', 'quarantine', '8000-session-parent-1', 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('POLLUTED')
    expect(existsSync(row)).toBe(false)
    expect(await listRestoreJournals(home)).toEqual([])
  })

  it('resumes a mid-switch interruption: quarantined live file plus pending publish', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.jsonl.zstd': 'BASE', 'session.v4.jsonl.zstd': 'POLLUTED' })
    projcacheRow(home, 'session-parent-1')
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.jsonl.zstd': 'BASE', 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    const liveStat = await stat(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'), { bigint: true })
    const journal: RestoreJournal = {
      version: 1,
      id: '8000-x',
      phase: 'intent',
      checkpointId: '1000',
      targetSessionId: 'session-parent-1',
      createdAt: 8000,
      updatedAt: 8000,
      quarantine: 'electron/quarantine/8000-x',
      members: [{
        sessionId: 'session-parent-1',
        dir: SESSION_DIR,
        header: PARENT,
        liveFiles: [
          { name: 'session.jsonl.zstd', size: 4, mtimeNs: '0' },
          { name: 'session.v4.jsonl.zstd', size: Number(liveStat.size), mtimeNs: String(liveStat.mtimeNs) },
        ],
        publish: [
          { name: 'session.jsonl.zstd', digest: sha('BASE') },
          { name: 'session.v4.jsonl.zstd', digest: sha('VERIFIED') },
        ],
      }],
    }
    await writeRestoreJournal(home, journal)
    // Simulate the crash point: session.jsonl.zstd already switched (live file
    // quarantined, canonical re-published), session.v4 still pending.
    const liveDir = join(home, 'sessions', SESSION_DIR)
    writeFile(join(home, 'electron', 'quarantine', '8000-x', 'sessions', SESSION_DIR, 'session.jsonl.zstd'), 'BASE')
    writeFile(join(liveDir, 'session.jsonl.zstd'), 'BASE')
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result.converged).toEqual(['8000-x'])
    expect(read(join(liveDir, 'session.v4.jsonl.zstd'))).toBe('VERIFIED')
    expect(read(join(liveDir, 'session.jsonl.zstd'))).toBe('BASE')
    expect(read(join(home, 'electron', 'quarantine', '8000-x', 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('POLLUTED')
    expect(await listRestoreJournals(home)).toEqual([])
  })

  it('re-stages a torn staged temp instead of publishing its bytes', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    await seedIntentJournal(home)
    // A crash mid-copy leaves a truncated staged temp; resume must not publish it.
    writeFileSync(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd.restore.tmp'), 'VERI')
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result.converged).toEqual(['8000-session-parent-1'])
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('VERIFIED')
  })

  it('stops and surfaces drift when a foreign writer appended during the interruption', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    await seedIntentJournal(home)
    // Foreign append after the crash: same name, new bytes.
    writeFileSync(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'), 'POLLUTED+FOREIGN-APPEND')
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result.converged).toEqual([])
    expect(result.conflicted).toEqual(['8000-session-parent-1'])
    // The foreign bytes survive; the journal is kept and marked.
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('POLLUTED+FOREIGN-APPEND')
    const journal = await readRestoreJournal(join(restoreJournalsDir(home), '8000-session-parent-1.json'))
    expect(journal?.phase).toBe('conflicted')
    expect(journal?.conflict).toContain('session.v4.jsonl.zstd')
  })

  it('a committed journal never re-applies the switch but still completes finalize', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'VERIFIED' })
    const row = projcacheRow(home, 'session-parent-1')
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    await seedIntentJournal(home, { phase: 'committed' })
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result.converged).toEqual(['8000-session-parent-1'])
    expect(existsSync(row)).toBe(false)
    expect(await listRestoreJournals(home)).toEqual([])
    // Live file untouched: still the post-switch bytes, no quarantine re-move.
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('VERIFIED')
    expect(existsSync(join(home, 'electron', 'quarantine', '8000-session-parent-1'))).toBe(false)
  })

  it('deletes a finalized leftover without touching anything', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'VERIFIED' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    await seedIntentJournal(home, { phase: 'finalized' })
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result.converged).toEqual(['8000-session-parent-1'])
    expect(await listRestoreJournals(home)).toEqual([])
  })

  it('defers a journal whose session lease is held by a foreign instance', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    await seedIntentJournal(home)
    const leases = fakeLeases()
    leases.held.add(SESSION_DIR)
    const result = await convergeRestoreJournals({ home, acquireLease: leases.acquire })
    expect(result.deferred).toEqual(['8000-session-parent-1'])
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('POLLUTED')
    expect(await listRestoreJournals(home)).toHaveLength(1)
  })

  it('skips a journal already marked conflicted', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'FOREIGN' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    await seedIntentJournal(home, { phase: 'conflicted', conflict: `${SESSION_DIR}/session.v4.jsonl.zstd` })
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result).toEqual({ converged: [], conflicted: ['8000-session-parent-1'], deferred: [] })
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('FOREIGN')
  })
})
