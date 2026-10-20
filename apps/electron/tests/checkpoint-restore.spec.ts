import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { stat } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { createRestoreJournalDecisions, runStartupSessionMaintenance } from '../src/checkpoint/startup.ts'
import { enqueuePendingRestore, listPendingRestores } from '../src/checkpoint/pending.ts'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { requireWritableFileSync } from './checkpoint-file-sync.ts'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}))

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
  vi.restoreAllMocks()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('restoreSession', () => {
  it('restores generation files while preserving extension artifacts', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, {
      'session.v4.jsonl.zstd': 'POLLUTED', 'metadata.json': 'CURRENT',
    })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED', 'metadata.json': 'OLD', 'removed.json': 'OLD' },
    }])
    const outcome = await restore(home, 'session-parent-1').run
    expect(outcome.kind).toBe('restored')
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('VERIFIED')
    expect(read(join(home, 'sessions', SESSION_DIR, 'metadata.json'))).toBe('CURRENT')
    expect(existsSync(join(home, 'sessions', SESSION_DIR, 'removed.json'))).toBe(false)
    if (outcome.kind !== 'restored') throw new Error('restore failed')
    expect(readdirSync(join(home, outcome.quarantine, 'sessions', SESSION_DIR))).toEqual(['session.v4.jsonl.zstd'])
  })

  it('replaces live files with verified checkpoint bytes and invalidates projcache', async () => {
    requireWritableFileSync()
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

  it('durably publishes a verified cross-volume quarantine copy before unlinking live', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    seedCheckpoint(home, '1000', [{ sessionId: PARENT.id, dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' } }])
    const live = join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd')
    const quarantine = join(home, 'electron/quarantine/9000-session-parent-1/sessions', SESSION_DIR, 'session.v4.jsonl.zstd')
    const synced = new Set<string>()
    const originalOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === `${quarantine}.restore.tmp`) expect(args[1]).toBe('r+')
      const handle = await originalOpen(...args)
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); synced.add(String(args[0])) })
      return handle
    })
    const rename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === live && String(to) === quarantine) {
        throw Object.assign(new Error('different volumes'), { code: 'EXDEV' })
      }
      return rename(from, to)
    })
    const unlink = fs.unlink
    vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      if (String(path) === live) {
        expect(read(quarantine)).toBe('POLLUTED')
        expect(synced.has(`${quarantine}.restore.tmp`)).toBe(true)
        if (process.platform !== 'win32') expect(synced.has(dirname(quarantine))).toBe(true)
      }
      return unlink(path)
    })
    expect(await restore(home, PARENT.id).run).toMatchObject({ kind: 'restored' })
    expect(read(live)).toBe('VERIFIED')
    expect(read(quarantine)).toBe('POLLUTED')
  })

  it('resumes a cross-volume move interrupted after quarantine publication', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    seedCheckpoint(home, '1000', [{ sessionId: PARENT.id, dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' } }])
    const live = join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd')
    const rename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === live) throw Object.assign(new Error('different volumes'), { code: 'EXDEV' })
      return rename(from, to)
    })
    const unlink = fs.unlink
    let interrupted = false
    vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      if (String(path) === live && !interrupted) { interrupted = true; throw new Error('interrupted before source removal') }
      return unlink(path)
    })
    expect((await restore(home, PARENT.id).run).kind).toBe('failed')
    expect(read(live)).toBe('POLLUTED')
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result.converged).toEqual(['9000-session-parent-1'])
    expect(read(live)).toBe('VERIFIED')
    expect(read(join(home, 'electron/quarantine/9000-session-parent-1/sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('POLLUTED')
  })

  it('preserves live bytes when a cross-volume quarantine copy fails verification', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    seedCheckpoint(home, '1000', [{ sessionId: PARENT.id, dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' } }])
    const live = join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd')
    const rename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === live) throw Object.assign(new Error('different volumes'), { code: 'EXDEV' })
      return rename(from, to)
    })
    const copy = fs.copyFile
    vi.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
      await copy(...args)
      if (String(args[1]).includes('quarantine')) writeFileSync(String(args[1]), 'TORN')
    })
    expect(await restore(home, PARENT.id).run).toMatchObject({ kind: 'failed' })
    expect(read(live)).toBe('POLLUTED')
    expect(await listRestoreJournals(home)).toHaveLength(1)
  })

  // A rename touches both parents; verify their flushes precede canonical publication.
  it.skipIf(process.platform === 'win32')('syncs both quarantine and live parents before publishing a replacement', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    seedCheckpoint(home, '1000', [{ sessionId: PARENT.id, dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' } }])
    const live = join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd')
    const synced = new Set<string>()
    const originalOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); synced.add(String(args[0])) })
      return handle
    })
    const rename = fs.rename
    let quarantined = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === live) { synced.clear(); quarantined = true }
      if (String(to) === live && quarantined) {
        expect(synced.has(dirname(live))).toBe(true)
        expect([...synced].some(path => path.includes('quarantine') && path.endsWith(SESSION_DIR))).toBe(true)
      }
      return rename(from, to)
    })
    expect((await restore(home, PARENT.id).run).kind).toBe('restored')
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

  it('reports partial recovery when a later related member changed', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'PARENT-POLLUTED' })
    liveSession(home, CHILD_DIR, { 'session.v4.jsonl.zstd': 'CHILD-POLLUTED' })
    seedCheckpoint(home, '1000', [
      { sessionId: PARENT.id, dir: SESSION_DIR, header: PARENT, files: { 'session.v4.jsonl.zstd': 'PARENT-VERIFIED' } },
      { sessionId: CHILD.id, dir: CHILD_DIR, header: CHILD, files: { 'session.v4.jsonl.zstd': 'CHILD-VERIFIED' } },
    ])
    const parent = join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd')
    const child = join(home, 'sessions', CHILD_DIR, 'session.v4.jsonl.zstd')
    const rename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (String(to) === parent) writeFileSync(child, 'CHILD-CHANGED-AFTER-INTENT')
    })
    expect(await restore(home, PARENT.id).run).toMatchObject({
      kind: 'conflicted', conflict: `${CHILD_DIR}/session.v4.jsonl.zstd`, journalId: '9000-session-parent-1',
      quarantine: 'electron/quarantine/9000-session-parent-1',
    })
    expect(read(parent)).toBe('PARENT-VERIFIED')
    expect(read(child)).toBe('CHILD-CHANGED-AFTER-INTENT')
    expect(read(join(home, 'electron/quarantine/9000-session-parent-1/sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('PARENT-POLLUTED')
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

  it('refuses a manifest whose session dir would escape the sessions root', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'LIVE' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: '../escape', header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    // A traversal in a durable session dir makes the manifest unreadable, so
    // the checkpoint never enters restore.
    const outcome = await restore(home, 'session-parent-1').run
    expect(outcome).toMatchObject({ kind: 'refused', reason: { key: 'no-checkpoint' } })
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('LIVE')
    expect(existsSync(join(home, 'escape'))).toBe(false)
  })

  it('skips a structurally malformed manifest and restores from the next-newest checkpoint', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED-1000' },
    }])
    seedCheckpoint(home, '2000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED-2000' },
    }])
    // Right version, wrong shape: `files`/`sessions` are not arrays.
    writeFileSync(join(checkpointsRoot(home), '2000', 'manifest.json'),
      JSON.stringify({ version: 1, id: '2000', capturedAt: 2000, files: 'nope', sessions: 42 }))
    const outcome = await restore(home, 'session-parent-1').run
    expect(outcome).toMatchObject({ kind: 'restored', checkpointId: '1000' })
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('VERIFIED-1000')
  })

  it('leaves nested archived artifacts outside the restore scope', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' },
    }])
    const manifestPath = join(checkpointsRoot(home), '1000', 'manifest.json')
    const manifest = JSON.parse(read(manifestPath)) as CheckpointManifest
    const nested = { path: `sessions/${SESSION_DIR}/sub/nested.bin`, origin: 'captured' as const, digest: sha('X') }
    mkdirSync(join(checkpointsRoot(home), '1000', 'sessions', SESSION_DIR, 'sub'), { recursive: true })
    writeFileSync(join(checkpointsRoot(home), '1000', 'sessions', SESSION_DIR, 'sub', 'nested.bin'), 'X')
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, files: [...manifest.files, nested] }))
    const outcome = await restore(home, 'session-parent-1').run
    expect(outcome.kind).toBe('restored')
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('VERIFIED')
    expect(existsSync(join(home, 'sessions', SESSION_DIR, 'sub'))).toBe(false)
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

  it('defers an intent that would publish an extension file without touching live data', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED', 'metadata.json': 'CURRENT' })
    seedCheckpoint(home, '1000', [{
      sessionId: 'session-parent-1', dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED', 'metadata.json': 'OLD' },
    }])
    const journal = await seedIntentJournal(home)
    await writeRestoreJournal(home, {
      ...journal,
      members: journal.members.map(member => ({
        ...member, publish: [...member.publish, { name: 'metadata.json', digest: sha('OLD') }],
      })),
    })
    const leases = fakeLeases()
    const result = await convergeRestoreJournals({ home, acquireLease: leases.acquire })
    expect(result).toEqual({ converged: [], conflicted: [], deferred: [journal.id], unresolvable: [] })
    expect(read(join(home, 'sessions', SESSION_DIR, 'metadata.json'))).toBe('CURRENT')
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('POLLUTED')
    expect(existsSync(join(home, journal.quarantine))).toBe(false)
    expect(await listRestoreJournals(home)).toHaveLength(1)
    expect(leases.held.size).toBe(0)
  })

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
    expect(result).toEqual({ converged: ['8000-session-parent-1'], conflicted: [], deferred: [], unresolvable: [] })
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
    expect(result).toEqual({ converged: [], conflicted: ['8000-session-parent-1'], deferred: [], unresolvable: [] })
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('FOREIGN')
  })

  it('reports an intent journal whose checkpoint is gone as unresolvable', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    await seedIntentJournal(home)
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result).toEqual({ converged: [], conflicted: [], deferred: [], unresolvable: ['8000-session-parent-1'] })
    // Live data and the recovery record both stay: only the user can abandon it.
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('POLLUTED')
    expect(await listRestoreJournals(home)).toHaveLength(1)
  })

  it('finalizes a committed journal even when its checkpoint is gone', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'VERIFIED' })
    const row = projcacheRow(home, 'session-parent-1')
    await seedIntentJournal(home, { phase: 'committed' })
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result).toEqual({ converged: ['8000-session-parent-1'], conflicted: [], deferred: [], unresolvable: [] })
    expect(existsSync(row)).toBe(false)
    expect(await listRestoreJournals(home)).toEqual([])
  })

  it('leaves a structurally malformed journal in place and untouched', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'LIVE' })
    // A hostile id would escape restore-journals/ on delete; a member dir or
    // publish name with traversal would escape sessions/. Both are unreadable.
    writeFile(join(restoreJournalsDir(home), 'bad-id.json'), JSON.stringify({
      version: 1, id: '../../escape', phase: 'intent', checkpointId: '1000',
      targetSessionId: 'session-parent-1', createdAt: 1, updatedAt: 1,
      quarantine: 'electron/quarantine/x', members: [],
    }))
    writeFile(join(restoreJournalsDir(home), 'bad-dir.json'), JSON.stringify({
      version: 1, id: 'bad-dir', phase: 'intent', checkpointId: '1000',
      targetSessionId: 'session-parent-1', createdAt: 1, updatedAt: 1,
      quarantine: 'electron/quarantine/bad-dir',
      members: [{ sessionId: 's', dir: '../escape', header: {}, liveFiles: [], publish: [] }],
    }))
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result).toEqual({ converged: [], conflicted: [], deferred: ['bad-dir', 'bad-id'], unresolvable: [] })
    const maintain = vi.fn(async () => {})
    expect(await runStartupSessionMaintenance({
      home,
      gate: async () => (await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })).deferred.length === 0,
      maintain, onError: (error) => { throw error },
    })).toBe(false)
    expect(maintain).not.toHaveBeenCalled()
    expect(await listRestoreJournals(home)).toHaveLength(2)
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('LIVE')
  })

  it('finishes an interrupted quarantine copy with both original copies present', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    seedCheckpoint(home, '1000', [{ sessionId: PARENT.id, dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' } }])
    const journal = await seedIntentJournal(home)
    const quarantine = join(home, journal.quarantine, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd')
    writeFile(quarantine, 'POLLUTED')
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result.converged).toEqual([journal.id])
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('VERIFIED')
    expect(read(quarantine)).toBe('POLLUTED')
  })

  it('does not restart a queued request already owned by an unfinished journal', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'POLLUTED' })
    seedCheckpoint(home, '1000', [{ sessionId: PARENT.id, dir: SESSION_DIR, header: PARENT,
      files: { 'session.v4.jsonl.zstd': 'VERIFIED' } }])
    await enqueuePendingRestore(home, PARENT.id, '1000')
    const request = (await listPendingRestores(home))[0]!
    const journal = await seedIntentJournal(home, { pendingRequestId: request.id })
    const { consumePendingSessionRestores } = await import('../src/checkpoint/index.ts')
    expect(await consumePendingSessionRestores({
      home, appPath: home, resourcesPath: home, packaged: false,
      hostRuntime: { executable: process.execPath, env: {} }, hostRunning: () => false,
    })).toEqual([])
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('POLLUTED')
    expect(await listPendingRestores(home)).toHaveLength(1)
    expect((await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })).converged).toEqual([journal.id])
    expect(await listPendingRestores(home)).toEqual([])
  })

  it('acknowledges a completed queued restore before deleting its journal', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'RESTORED-THEN-APPENDED' })
    await enqueuePendingRestore(home, PARENT.id, '1000')
    const request = (await listPendingRestores(home))[0]!
    const journal = await seedIntentJournal(home, { phase: 'finalized', pendingRequestId: request.id })
    const originalRm = fs.rm
    let interrupted = false
    vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
      if (args[0] === join(restoreJournalsDir(home), `${journal.id}.json`) && !interrupted) {
        interrupted = true
        expect(await listPendingRestores(home)).toEqual([])
        throw new Error('interrupted before journal deletion')
      }
      return originalRm(...args)
    })
    expect((await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })).deferred).toEqual([journal.id])
    expect(await listPendingRestores(home)).toEqual([])
    expect((await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })).converged).toEqual([journal.id])
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('RESTORED-THEN-APPENDED')
  })

  it.each(['EIO', 'EACCES'])('retains a committed journal until a legacy-cache %s clears', async (code) => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'RESTORED-THEN-APPENDED' })
    const legacyPath = join(home, 'storages', 'session_projcache.json')
    const document = JSON.stringify({
      unit: { name: 'session_projcache', version: 1 },
      tables: { sessions: { 'session-parent-1': { stale: true }, other: { keep: true } } },
    })
    writeFile(legacyPath, document)
    const journal = await seedIntentJournal(home, { phase: 'committed' })
    const originalReadFile = fs.readFile
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (args[0] === legacyPath) {
        throw Object.assign(new Error('transient legacy-cache read failure'), { code })
      }
      return originalReadFile(...args)
    })
    const first = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(first.deferred).toEqual([journal.id])
    expect((await readRestoreJournal(join(restoreJournalsDir(home), `${journal.id}.json`)))?.phase).toBe('committed')
    expect(read(legacyPath)).toBe(document)
    vi.restoreAllMocks()
    const resumed = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(resumed.converged).toEqual([journal.id])
    expect(await listRestoreJournals(home)).toEqual([])
    expect(JSON.parse(read(legacyPath))).toEqual({
      unit: { name: 'session_projcache', version: 1 }, tables: { sessions: { other: { keep: true } } },
    })
    expect(read(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'))).toBe('RESTORED-THEN-APPENDED')
  })

  it('invalidates member rows inside the legacy whole-unit projcache file', async () => {
    const home = makeHome()
    liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'VERIFIED' })
    const legacyPath = join(home, 'storages', 'session_projcache.json')
    writeFile(legacyPath, JSON.stringify({
      unit: { name: 'session_projcache', version: 1 },
      tables: { sessions: { 'session-parent-1': { stale: true }, 'other-session': { keep: true } } },
    }))
    await seedIntentJournal(home, { phase: 'committed' })
    const result = await convergeRestoreJournals({ home, acquireLease: fakeLeases().acquire })
    expect(result.converged).toEqual(['8000-session-parent-1'])
    const legacy = JSON.parse(read(legacyPath)) as { tables: { sessions: Record<string, unknown> } }
    expect(Object.keys(legacy.tables.sessions)).toEqual(['other-session'])
  })

  describe('startup journal decisions', () => {
    it.each(['deferred', 'unresolvable', 'conflicted'] as const)('presents an unchanged %s journal once per launch', async (kind) => {
      const home = makeHome()
      liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'LIVE' })
      await seedIntentJournal(home)
      const presented: string[] = []
      const gate: Parameters<typeof runStartupSessionMaintenance>[0]['gate'] = async (decisions) => {
        for (const decision of await decisions(kind, ['8000-session-parent-1'])) {
          presented.push(decision.id)
          decision.acknowledge()
        }
        return true
      }
      const options = { home, gate, maintain: async () => {}, onError: (error: unknown) => { throw error } }
      expect(await runStartupSessionMaintenance(options)).toBe(true)
      expect(presented).toEqual(['8000-session-parent-1'])
      expect(await runStartupSessionMaintenance(options)).toBe(true)
      expect(presented).toHaveLength(2)
    })

    it('presents new and changed journals after maintenance fails', async () => {
      const home = makeHome()
      liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'LIVE' })
      const journal = await seedIntentJournal(home)
      const presented: string[] = []
      const errors: unknown[] = []
      const ids = [journal.id]
      expect(await runStartupSessionMaintenance({
        home,
        gate: async (decisions) => {
          for (const decision of await decisions('deferred', ids)) {
            presented.push(decision.id)
            decision.acknowledge()
          }
          return true
        },
        maintain: async () => {
          await writeRestoreJournal(home, { ...journal, phase: 'committed' })
          await writeRestoreJournal(home, { ...journal, id: 'new-journal' })
          ids.push('new-journal')
          throw new Error('maintenance interrupted')
        },
        onError: (error) => { errors.push(error) },
      })).toBe(true)
      expect(presented).toEqual([journal.id, journal.id, 'new-journal'])
      expect(errors).toHaveLength(1)
    })

    it('requires a new decision when the convergence outcome changes', async () => {
      const home = makeHome()
      liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'LIVE' })
      const journal = await seedIntentJournal(home)
      const decisions = createRestoreJournalDecisions(home)
      const deferred = await decisions('deferred', [journal.id])
      deferred[0]!.acknowledge()
      const conflicted = await decisions('conflicted', [journal.id])
      expect(conflicted).toHaveLength(1)
      conflicted[0]!.acknowledge()
      expect(await decisions('deferred', [journal.id])).toHaveLength(1)
    })

    it('keeps unreadable journal contents eligible for another decision', async () => {
      const home = makeHome()
      liveSession(home, SESSION_DIR, { 'session.v4.jsonl.zstd': 'LIVE' })
      const journal = await seedIntentJournal(home)
      const originalReadFile = fs.readFile
      vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
        if (args[0] === join(restoreJournalsDir(home), `${journal.id}.json`)) {
          throw Object.assign(new Error('journal read unavailable'), { code: 'EIO' })
        }
        return originalReadFile(...args)
      })
      const decisions = createRestoreJournalDecisions(home)
      const first = await decisions('deferred', [journal.id])
      first[0]!.acknowledge()
      expect(await decisions('deferred', [journal.id])).toHaveLength(1)
    })
  })
})
