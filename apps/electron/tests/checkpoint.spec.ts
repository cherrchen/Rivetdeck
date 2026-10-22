import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as nativeFs from 'node:fs'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import { writeRestoreJournal } from '../src/checkpoint/journal.ts'
import { dequeuePendingRestore, enqueuePendingRestore, listPendingRestores } from '../src/checkpoint/pending.ts'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  pruneCheckpoints,
  runExitCheckpoint,
  stageCandidate,
  sweepStaleCandidates,
  type ValidateSessions,
} from '../src/checkpoint/capture.ts'
import { checkpointsRoot, readManifest, type CheckpointManifest } from '../src/checkpoint/manifest.ts'
import { isPromotableReport } from '../src/checkpoint/promotion.ts'
import { requireWritableFileSync } from './checkpoint-file-sync.ts'
import {
  mergeMainShutdownFacts,
  shutdownReportPath,
  writeShutdownReportSync,
  type HostShutdownSection,
  type MainShutdownSection,
} from '../src/harness/shutdown-report.ts'

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
}))

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}))

const roots: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-checkpoint-'))
  roots.push(home)
  return home
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

const CHILD_PID = 4242

async function writeReport(
  home: string,
  host: Partial<HostShutdownSection> = {},
  main: Partial<MainShutdownSection> = {},
): Promise<void> {
  writeShutdownReportSync(home, {
    pid: CHILD_PID, reachedReady: true, requestedBy: 'SIGTERM', dispose: 'clean', exitCode: 0, ...host,
  })
  await mergeMainShutdownFacts(home, {
    pid: CHILD_PID, signal: 'SIGTERM', timeout: false, kill: false, exitCode: 0, signalCode: null, ...main,
  })
}

/** Live home with one session plus the rest of the covered set and excluded noise. Returns the session dir relative to `sessions/`. */
function populateHome(home: string, sessionBytes = 'LIVE-SESSION'): string {
  const sessionDir = join(home, 'sessions', '--work--', 'session-aaaa-1111')
  writeFile(join(sessionDir, 'session.jsonl.zstd'), sessionBytes)
  writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), sessionBytes)
  writeFile(join(sessionDir, 'session.lock'), '')
  writeFile(join(sessionDir, 'session.migration.1.tmp'), 'partial')
  writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'patch')
  writeFile(join(home, 'profiles', 'web', 'package.json'), '{}')
  writeFile(join(home, 'profiles', 'web', 'node_modules', 'should-not-copy.js'), 'x')
  writeFile(join(home, 'cordis.patch.yml'), 'home-patch')
  writeFile(join(home, 'storages', 'session_projcache.json'), '{}')
  writeFile(join(home, 'storages', 'session_projcache', 'sessions', 'row.json'), '{}')
  writeFile(join(home, 'storages', 'session_projcache.lock'), '')
  writeFile(join(home, 'storages', 'workspace.json'), '{}')
  writeFile(join(home, '.env'), 'KEY=1')
  return '--work--/session-aaaa-1111'
}

/**
 * In-test validator: enumerates session dirs under the staged root and passes
 * every one not named in `fail`. `dir`/`sessionId` mirror worker output.
 */
function fakeValidator(fail: ReadonlySet<string> = new Set(), formatVersion = 4): ValidateSessions & { calls: string[] } {
  const calls: string[] = []
  const validate: ValidateSessions = async (root) => {
    calls.push(root)
    const sessions = []
    if (existsSync(root)) {
      for (const projectKey of readdirSync(root)) {
        const projectDir = join(root, projectKey)
        for (const dir of readdirSync(projectDir)) {
          const rel = `${projectKey}/${dir}`
          sessions.push({
            sessionId: dir.replace(/^session-/, ''),
            dir: rel,
            ok: !fail.has(rel),
            ...(fail.has(rel) ? { error: 'SessionFormatUnsupportedError: test refusal' } : {}),
          })
        }
      }
    }
    return { sessionFormatVersion: formatVersion, sessions }
  }
  return Object.assign(validate, { calls })
}

function committedIds(home: string): string[] {
  const root = checkpointsRoot(home)
  if (!existsSync(root)) return []
  return readdirSync(root).filter(name => !name.endsWith('.tmp'))
}

function captureAt(home: string, id: number) {
  return runExitCheckpoint({
    home, childPid: CHILD_PID, appVersion: 'test', validate: fakeValidator(), now: () => id,
  })
}

/** Seed a committed checkpoint holding one verified copy of `sessionDir`. */
function seedCheckpoint(home: string, id: string, sessionDir: string, bytes: string): CheckpointManifest {
  const dir = join(checkpointsRoot(home), id)
  const fileRel = `sessions/${sessionDir}/session.v4.jsonl.zstd`
  writeFile(join(dir, fileRel), bytes)
  const manifest: CheckpointManifest = {
    version: 1,
    id,
    capturedAt: Number(id),
    shutdown: JSON.parse(readFileSync(shutdownReportPath(home), 'utf8')) as CheckpointManifest['shutdown'],
    files: [{
      path: fileRel,
      origin: 'captured',
      digest: { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      source: { path: fileRel, size: bytes.length, mtimeNs: '1' },
    }],
    sessions: [{
      sessionId: sessionDir.replace(/^session-/, ''),
      dir: sessionDir,
      capturedAt: Number(id),
      sourceCheckpointId: id,
      validator: { appVersion: 'prev', sessionFormatVersion: 4 },
    }],
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  return manifest
}

afterEach(() => {
  vi.restoreAllMocks()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('pending restore read failures', () => {
  it('returns an empty queue when the pending file is absent', async () => {
    expect(await listPendingRestores(makeHome())).toEqual([])
  })

  it.each(['EACCES', 'EIO'])('preserves queued requests on %s', async (code) => {
    const home = makeHome()
    await enqueuePendingRestore(home, 'one', '1000')
    const pendingPath = join(home, 'electron', 'pending-restore.json')
    const before = readFileSync(pendingPath, 'utf8')
    const failure = Object.assign(new Error('pending queue read failed'), { code })
    const readFile = fs.readFile
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (args[0] === pendingPath) throw failure
      return readFile(...args)
    })
    try {
      await expect(listPendingRestores(home)).rejects.toBe(failure)
      await expect(enqueuePendingRestore(home, 'two', '2000')).rejects.toBe(failure)
      await expect(dequeuePendingRestore(home, 'one')).rejects.toBe(failure)
      expect(readFileSync(pendingPath, 'utf8')).toBe(before)
    } finally {
      spy.mockRestore()
    }
    expect(await listPendingRestores(home)).toMatchObject([{ sessionId: 'one', checkpointId: '1000' }])
  })
})

describe('stageCandidate cancellation', () => {
  it('does not open copy streams when cancelled during destination creation', async () => {
    const home = makeHome()
    const rel = 'sessions/--work--/session-aaaa/session.v4.jsonl.zstd'
    writeFile(join(home, rel), 'SESSION')
    const controller = new AbortController()
    const failure = new Error('capture deadline expired')
    const mkdir = fs.mkdir
    vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
      const result = await mkdir(...args)
      if (String(args[0]) === dirname(join(checkpointsRoot(home), '1000.tmp', rel))) {
        controller.abort(failure)
      }
      return result
    })
    const read = vi.spyOn(nativeFs, 'createReadStream')
    const write = vi.spyOn(nativeFs, 'createWriteStream')
    await expect(stageCandidate(home, '1000', controller.signal)).rejects.toBe(failure)
    expect(controller.signal.aborted).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('closes both copy streams before rejecting an in-flight cancellation', async () => {
    const home = makeHome()
    const rel = 'sessions/--work--/session-aaaa/session.v4.jsonl.zstd'
    const content = 'x'.repeat(1024 * 1024)
    writeFile(join(home, rel), content)
    const controller = new AbortController()
    let read: nativeFs.ReadStream | undefined
    let write: nativeFs.WriteStream | undefined
    const createRead = nativeFs.createReadStream
    vi.spyOn(nativeFs, 'createReadStream').mockImplementation((...args) => {
      read = createRead(...args)
      read.once('data', () => { controller.abort() })
      return read
    })
    const createWrite = nativeFs.createWriteStream
    vi.spyOn(nativeFs, 'createWriteStream').mockImplementation((...args) => {
      write = createWrite(...args)
      return write
    })
    await expect(stageCandidate(home, '1000', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read?.closed).toBe(true)
    expect(write?.closed).toBe(true)
    expect(read?.bytesRead).toBeLessThan(content.length)
  })
})

describe('isPromotableReport', () => {
  const clean = {
    version: 1 as const,
    recordedAt: 1,
    host: { pid: CHILD_PID, reachedReady: true, requestedBy: 'SIGTERM' as const, dispose: 'clean' as const, exitCode: 0 },
    main: { pid: CHILD_PID, signal: 'SIGTERM' as const, timeout: false, kill: false, exitCode: 0, signalCode: null },
  }

  it('accepts a same-pid clean report', () => {
    expect(isPromotableReport(clean, CHILD_PID)).toBe(true)
  })

  it('refuses missing sections and pid mismatches', () => {
    expect(isPromotableReport({}, CHILD_PID)).toBe(false)
    expect(isPromotableReport({ ...clean, host: undefined }, CHILD_PID)).toBe(false)
    expect(isPromotableReport(clean, CHILD_PID + 1)).toBe(false)
    expect(isPromotableReport({ ...clean, host: { ...clean.host, pid: 999 } }, CHILD_PID)).toBe(false)
  })

  it('refuses timeout, kill, signal and nonzero exits', () => {
    expect(isPromotableReport({ ...clean, main: { ...clean.main, timeout: true, kill: true, signalCode: 'SIGKILL' as const, exitCode: null } }, CHILD_PID)).toBe(false)
    expect(isPromotableReport({ ...clean, main: { ...clean.main, exitCode: 1 } }, CHILD_PID)).toBe(false)
    expect(isPromotableReport({ ...clean, main: { ...clean.main, signalCode: 'SIGKILL' as const, exitCode: null } }, CHILD_PID)).toBe(false)
  })

  it('refuses unready or unclean host drains', () => {
    expect(isPromotableReport({ ...clean, host: { ...clean.host, reachedReady: false } }, CHILD_PID)).toBe(false)
    expect(isPromotableReport({ ...clean, host: { ...clean.host, dispose: 'timeout' as const } }, CHILD_PID)).toBe(false)
    expect(isPromotableReport({ ...clean, host: { ...clean.host, exitCode: 1 } }, CHILD_PID)).toBe(false)
  })
})

describe('runExitCheckpoint', () => {
  it.each(['EACCES', 'EIO', 'ENOENT'])('aborts capture on %s while enumerating a session directory', async (code) => {
    const home = makeHome()
    const sessionDir = populateHome(home)
    await writeReport(home)
    expect((await captureAt(home, 1000)).kind).toBe('committed')
    const previous = readFileSync(join(checkpointsRoot(home), '1000', 'manifest.json'), 'utf8')
    const readdir = fs.readdir
    const failure = Object.assign(new Error(`session enumeration: ${code}`), { code })
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      if (String(args[0]) === join(home, 'sessions', sessionDir)) throw failure
      return readdir(...args)
    })
    expect(await captureAt(home, 2000)).toEqual({ kind: 'aborted', reason: failure.message })
    expect(committedIds(home)).toEqual(['1000'])
    expect(readFileSync(join(checkpointsRoot(home), '1000', 'manifest.json'), 'utf8')).toBe(previous)
  })

  it.each(['EACCES', 'EIO'])('aborts capture on %s at the sessions root', async (code) => {
    const home = makeHome()
    populateHome(home)
    await writeReport(home)
    const readdir = fs.readdir
    const failure = Object.assign(new Error(`root enumeration: ${code}`), { code })
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      if (String(args[0]) === join(home, 'sessions')) throw failure
      return readdir(...args)
    })
    expect(await captureAt(home, 2000)).toEqual({ kind: 'aborted', reason: failure.message })
    expect(committedIds(home)).toEqual([])
  })

  it('captures a home whose sessions root does not exist yet', async () => {
    const home = makeHome()
    await writeReport(home)
    expect(await captureAt(home, 1000)).toMatchObject({ kind: 'committed', sessions: 0 })
  })

  it('skips when no promotable report exists', async () => {
    const home = makeHome()
    populateHome(home)
    expect(await runExitCheckpoint({ home, childPid: CHILD_PID, appVersion: '1.0.0', validate: fakeValidator() }))
      .toMatchObject({ kind: 'skipped' })
    expect(committedIds(home)).toEqual([])
  })

  it('commits a validated checkpoint over the covered set', async () => {
    requireWritableFileSync()
    const home = makeHome()
    const sessionDir = populateHome(home)
    await writeReport(home)
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: '1.2.3', validate: fakeValidator(), now: () => 1700,
    })
    expect(outcome).toMatchObject({ kind: 'committed', id: '1700', sessions: 1 })
    const dir = join(checkpointsRoot(home), '1700')
    expect(readFileSync(join(dir, 'sessions', sessionDir, 'session.v4.jsonl.zstd'), 'utf8')).toBe('LIVE-SESSION')
    expect(readFileSync(join(dir, 'profiles/web/package.json'), 'utf8')).toBe('{}')
    expect(existsSync(join(dir, 'storages/session_projcache.json'))).toBe(true)
    expect(existsSync(join(dir, 'storages/session_projcache/sessions/row.json'))).toBe(true)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('KEY=1')
    // Excluded: locks, staging temporaries, unmanaged storage, node_modules.
    expect(existsSync(join(dir, 'sessions/--work--/session-aaaa-1111/session.lock'))).toBe(false)
    expect(existsSync(join(dir, 'sessions/--work--/session-aaaa-1111/session.migration.1.tmp'))).toBe(false)
    expect(existsSync(join(dir, 'storages/session_projcache.lock'))).toBe(false)
    expect(existsSync(join(dir, 'storages/workspace.json'))).toBe(false)
    expect(existsSync(join(dir, 'profiles/web/node_modules'))).toBe(false)
    const manifest = await readManifest(dir)
    expect(manifest?.shutdown.host?.pid).toBe(CHILD_PID)
    expect(manifest?.sessions).toEqual([{
      sessionId: 'aaaa-1111',
      dir: '--work--/session-aaaa-1111',
      capturedAt: 1700,
      sourceCheckpointId: '1700',
      validator: { appVersion: '1.2.3', sessionFormatVersion: 4 },
    }])
    const file = manifest?.files.find(entry => entry.path.endsWith('session.v4.jsonl.zstd'))
    expect(file?.digest.sha256).toBe(createHash('sha256').update('LIVE-SESSION').digest('hex'))
    expect(file?.source?.path).toBe(`sessions/${sessionDir}/session.v4.jsonl.zstd`)
  })

  it('carries the previous verified copy forward when the live copy fails validation', async () => {
    const home = makeHome()
    await writeReport(home)
    const sessionDir = populateHome(home, 'POLLUTED')
    seedCheckpoint(home, '1000', sessionDir, 'VERIFIED-OLD')
    const validate = fakeValidator(new Set([sessionDir]))
    // The carried copy validates on the second pass.
    let calls = 0
    const wrapped: ValidateSessions = async (root) => {
      calls += 1
      return calls === 1 ? await validate(root) : await fakeValidator()(root)
    }
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: '2.0.0', validate: wrapped, now: () => 2000,
    })
    expect(outcome).toMatchObject({ kind: 'committed', id: '2000' })
    const dir = join(checkpointsRoot(home), '2000')
    expect(readFileSync(join(dir, 'sessions', sessionDir, 'session.v4.jsonl.zstd'), 'utf8')).toBe('VERIFIED-OLD')
    const manifest = await readManifest(dir)
    const carried = manifest?.files.find(entry => entry.path === `sessions/${sessionDir}/session.v4.jsonl.zstd`)
    expect(carried?.origin).toBe('carried')
    expect(carried?.sourceCheckpointId).toBe('1000')
    expect(manifest?.sessions[0]?.sourceCheckpointId).toBe('1000')
    expect(manifest?.sessions[0]?.capturedAt).toBe(1000)
    expect(calls).toBe(2)
  })

  it('flushes a carried copy when hard-link materialization is unavailable', async () => {
    const home = makeHome()
    await writeReport(home)
    const dir = populateHome(home, 'POLLUTED')
    seedCheckpoint(home, '1000', dir, 'VERIFIED')
    vi.spyOn(nativeFs, 'linkSync').mockImplementation(() => { throw new Error('hard links unavailable') })
    const open = fs.open
    let flushed = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]) === join(checkpointsRoot(home), '2000.tmp', 'sessions', dir, 'session.v4.jsonl.zstd')) {
        expect(args[1]).toBe('r+')
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); flushed = true })
      }
      return handle
    })
    let calls = 0
    expect((await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: 'test', now: () => 2000,
      validate: async root => (++calls === 1 ? fakeValidator(new Set([dir]))(root) : fakeValidator()(root)),
    })).kind).toBe('committed')
    expect(flushed).toBe(true)
    expect(readFileSync(join(checkpointsRoot(home), '2000', 'sessions', dir, 'session.v4.jsonl.zstd'), 'utf8')).toBe('VERIFIED')
  })

  it('drops a failed session that has no verified copy', async () => {
    const home = makeHome()
    await writeReport(home)
    const sessionDir = populateHome(home, 'POLLUTED')
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: '1.0.0',
      validate: fakeValidator(new Set([sessionDir])), now: () => 3000,
    })
    expect(outcome).toMatchObject({ kind: 'committed', sessions: 0 })
    const dir = join(checkpointsRoot(home), '3000')
    expect(existsSync(join(dir, 'sessions', sessionDir))).toBe(false)
    const manifest = await readManifest(dir)
    expect(manifest?.sessions).toEqual([])
    expect(manifest?.files.some(entry => entry.path === `sessions/${sessionDir}/session.v4.jsonl.zstd`)).toBe(false)
  })

  it('aborts when the mixed set still fails re-validation', async () => {
    const home = makeHome()
    await writeReport(home)
    const sessionDir = populateHome(home)
    seedCheckpoint(home, '1000', sessionDir, 'OLD')
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: '1.0.0',
      validate: fakeValidator(new Set([sessionDir])), now: () => 4000,
    })
    expect(outcome).toMatchObject({ kind: 'aborted' })
    expect(committedIds(home)).toEqual(['1000'])
    expect(readdirSync(checkpointsRoot(home)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('excludes a failed session the previous checkpoint never held instead of aborting', async () => {
    const home = makeHome()
    await writeReport(home)
    const sessionDir = populateHome(home)
    const extra = '--work--/session-bbbb-2222'
    writeFile(join(home, 'sessions', extra, 'session.v4.jsonl.zstd'), 'POLLUTED-NEW')
    seedCheckpoint(home, '1000', sessionDir, 'VERIFIED-OLD')
    let calls = 0
    const failing = fakeValidator(new Set([extra]))
    const validate: ValidateSessions = async (root) => {
      calls += 1
      return calls === 1 ? failing(root) : fakeValidator()(root)
    }
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: '1.0.0', validate, now: () => 2000,
    })
    expect(outcome).toMatchObject({ kind: 'committed', id: '2000' })
    const committed = join(checkpointsRoot(home), '2000')
    expect(existsSync(join(committed, 'sessions', ...extra.split('/')))).toBe(false)
    const manifest = await readManifest(committed)
    expect(manifest?.files.some(entry => entry.path.startsWith(`sessions/${extra}/`))).toBe(false)
    expect(manifest?.sessions.map(entry => entry.dir)).toEqual([sessionDir])
  })

  it('aborts on cancellation without committing', async () => {
    const home = makeHome()
    populateHome(home)
    await writeReport(home)
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: '1.0.0',
      validate: fakeValidator(), signal: AbortSignal.abort(),
    })
    expect(outcome).toMatchObject({ kind: 'aborted' })
    expect(committedIds(home)).toEqual([])
  })

  it('stops candidate cleanup on cancellation and removes its remainder in the next sweep', async () => {
    const home = makeHome()
    populateHome(home)
    await writeReport(home)
    const controller = new AbortController()
    const unlink = fs.unlink
    const removed: string[] = []
    vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      await unlink(path)
      removed.push(String(path))
      controller.abort()
    })
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: 'test', now: () => 2000, signal: controller.signal,
      validate: async () => { throw new Error('validation failed') },
    })
    expect(outcome.kind).toBe('aborted')
    expect(removed).toHaveLength(1)
    expect(readdirSync(checkpointsRoot(home))).toEqual(['2000.tmp'])
    vi.restoreAllMocks()
    await sweepStaleCandidates(checkpointsRoot(home))
    expect(readdirSync(checkpointsRoot(home))).toEqual([])
  })

  it('does not publish when validation finishes after cancellation', async () => {
    const home = makeHome()
    populateHome(home)
    await writeReport(home)
    const controller = new AbortController()
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: 'test', now: () => 2000, signal: controller.signal,
      validate: async (root) => { const report = await fakeValidator()(root); controller.abort(); return report },
    })
    expect(outcome.kind).toBe('aborted')
    expect(readdirSync(checkpointsRoot(home))).toEqual(['2000.tmp'])
  })

  it('stops directory traversal after cancellation and keeps existing checkpoints', async () => {
    const home = makeHome()
    const dir = populateHome(home)
    await writeReport(home)
    seedCheckpoint(home, '1000', dir, 'VERIFIED')
    const controller = new AbortController()
    const original = fs.readdir
    const candidate = join(checkpointsRoot(home), '2000.tmp')
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      const result = await original(...args)
      if (String(args[0]) === candidate) controller.abort()
      return result
    })
    const rename = vi.spyOn(fs, 'rename')
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: 'test', validate: fakeValidator(), now: () => 2000, signal: controller.signal,
    })
    expect(outcome.kind).toBe('aborted')
    expect(rename.mock.calls.some(([, to]) => String(to) === join(checkpointsRoot(home), '2000'))).toBe(false)
    expect(readdirSync(checkpointsRoot(home))).toEqual(['1000', '2000.tmp'])
  })

  it.skipIf(process.platform === 'win32')('does not publish after cancellation during the final directory flush', async () => {
    const home = makeHome()
    const dir = populateHome(home)
    await writeReport(home)
    seedCheckpoint(home, '1000', dir, 'VERIFIED')
    const controller = new AbortController()
    const original = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args)
      if (String(args[0]) === join(checkpointsRoot(home), '2000.tmp', 'sessions', ...dir.split('/')) && args[1] === 'r') {
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); controller.abort() })
      }
      return handle
    })
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: 'test', validate: fakeValidator(), now: () => 2000, signal: controller.signal,
    })
    expect(outcome.kind).toBe('aborted')
    expect(readdirSync(checkpointsRoot(home))).toEqual(['1000', '2000.tmp'])
  })

  it('finishes publication and skips pruning when cancellation arrives after rename', async () => {
    const home = makeHome()
    populateHome(home)
    await writeReport(home)
    for (const id of [1000, 2000, 3000]) expect((await captureAt(home, id)).kind).toBe('committed')
    const controller = new AbortController()
    const original = fs.rename
    let flushedRoot = false
    const originalOpen = fs.open
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      await original(...args)
      if (String(args[1]) === join(checkpointsRoot(home), '4000')) controller.abort()
    })
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === checkpointsRoot(home) && args[1] === 'r') {
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); flushedRoot = true })
      }
      return handle
    })
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: 'test', validate: fakeValidator(), now: () => 4000, signal: controller.signal,
    })
    expect(outcome).toMatchObject({ kind: 'committed', id: '4000' })
    expect(await readManifest(join(checkpointsRoot(home), '4000'))).toBeDefined()
    expect(committedIds(home)).toEqual(['1000', '2000', '3000', '4000'])
    if (process.platform !== 'win32') expect(flushedRoot).toBe(true)
  })

  it('reports an already published checkpoint as committed when retention is cancelled', async () => {
    const home = makeHome()
    populateHome(home)
    await writeReport(home)
    for (const id of [1000, 2000, 3000]) expect((await captureAt(home, id)).kind).toBe('committed')
    const controller = new AbortController()
    const originalRename = fs.rename
    let published = false
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      await originalRename(...args)
      if (String(args[1]) === join(checkpointsRoot(home), '4000')) published = true
    })
    const originalRead = fs.readFile
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const result = await originalRead(...args)
      if (published && args[0] === join(checkpointsRoot(home), '4000', 'manifest.json')) controller.abort()
      return result
    })
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: 'test', validate: fakeValidator(), now: () => 4000, signal: controller.signal,
    })
    expect(controller.signal.aborted).toBe(true)
    expect(outcome).toMatchObject({ kind: 'committed', id: '4000' })
    expect(committedIds(home)).toEqual(['1000', '2000', '3000', '4000'])
  })

  it('aborts when the carried copy is omitted from the second listing', async () => {
    const home = makeHome()
    const dir = populateHome(home)
    await writeReport(home)
    seedCheckpoint(home, '1000', dir, 'OLD')
    let calls = 0
    const outcome = await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: 'older', now: () => 2000,
      validate: async () => (++calls === 1
        ? { sessionFormatVersion: 4, sessions: [{ sessionId: 'aaaa-1111', dir, ok: false }] }
        : { sessionFormatVersion: 4, sessions: [] }),
    })
    expect(outcome).toMatchObject({ kind: 'aborted', reason: `re-validation failed for ${dir}` })
    expect(committedIds(home)).toEqual(['1000'])
    expect(readdirSync(checkpointsRoot(home))).toEqual(['1000'])
  })

  it('protects an intent journal input through exit captures and releases it after finalization', async () => {
    const home = makeHome()
    populateHome(home)
    await writeReport(home)
    expect((await captureAt(home, 1000)).kind).toBe('committed')
    const journal = { version: 1 as const, id: 'intent', phase: 'intent' as const, checkpointId: '1000',
      targetSessionId: 'aaaa-1111', createdAt: 1, updatedAt: 1, quarantine: 'electron/quarantine/intent', members: [] }
    await writeRestoreJournal(home, journal)
    for (const id of [2000, 3000, 4000, 5000]) expect((await captureAt(home, id)).kind).toBe('committed')
    expect(existsSync(join(checkpointsRoot(home), '1000'))).toBe(true)
    await writeRestoreJournal(home, { ...journal, phase: 'committed' })
    expect((await captureAt(home, 6000)).kind).toBe('committed')
    expect(existsSync(join(checkpointsRoot(home), '1000'))).toBe(false)
  })

  it('does not prune when an unreadable journal may refer to an older checkpoint', async () => {
    const home = makeHome()
    populateHome(home)
    await writeReport(home)
    writeFile(join(home, 'electron/restore-journals/broken.json'), '{invalid')
    for (const id of [1000, 2000, 3000, 4000]) {
      expect((await runExitCheckpoint({
        home, childPid: CHILD_PID, appVersion: 'test', validate: fakeValidator(), now: () => id,
      })).kind).toBe('committed')
    }
    expect(committedIds(home)).toEqual(['1000', '2000', '3000', '4000'])
  })

  it('suspends pruning when a pending queue read fails and resumes after recovery', async () => {
    const home = makeHome()
    populateHome(home)
    await writeReport(home)
    for (const id of [1000, 2000, 3000]) expect((await captureAt(home, id)).kind).toBe('committed')
    await enqueuePendingRestore(home, 'aaaa-1111', '1000')
    const pendingPath = join(home, 'electron', 'pending-restore.json')
    const before = readFileSync(pendingPath, 'utf8')
    const readFile = fs.readFile
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (args[0] === pendingPath) throw Object.assign(new Error('read failed'), { code: 'EIO' })
      return readFile(...args)
    })
    try {
      expect((await captureAt(home, 4000)).kind).toBe('committed')
      expect(committedIds(home)).toEqual(['1000', '2000', '3000', '4000'])
      expect(readFileSync(pendingPath, 'utf8')).toBe(before)
    } finally {
      spy.mockRestore()
    }
    expect(await listPendingRestores(home)).toMatchObject([{ checkpointId: '1000' }])
    expect((await captureAt(home, 5000)).kind).toBe('committed')
    expect(committedIds(home)).toEqual(['1000', '3000', '4000', '5000'])
    await dequeuePendingRestore(home, 'aaaa-1111')
    expect((await captureAt(home, 6000)).kind).toBe('committed')
    expect(committedIds(home)).toEqual(['4000', '5000', '6000'])
  })

  // Directory fsync is POSIX-only; Windows exercises file flushes separately.
  it.skipIf(process.platform === 'win32')('flushes the staged directory hierarchy before publication', async () => {
    const home = makeHome()
    const dir = populateHome(home)
    await writeReport(home)
    const synced = new Set<string>()
    const originalOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        await sync()
        if ((await handle.stat()).isDirectory()) synced.add(String(args[0]))
      })
      return handle
    })
    const rename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === join(checkpointsRoot(home), '7000')) {
        const staged = join(checkpointsRoot(home), '7000.tmp')
        for (const path of ['sessions', 'sessions/--work--', `sessions/${dir}`, 'profiles/web', 'storages/session_projcache/sessions']) {
          expect(synced.has(join(staged, path)), path).toBe(true)
        }
      }
      return rename(from, to)
    })
    expect((await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: 'test', validate: fakeValidator(), now: () => 7000,
    })).kind).toBe('committed')
  })

  it.skipIf(process.platform === 'win32')('does not publish or prune after a session-directory sync failure', async () => {
    const home = makeHome()
    const dir = populateHome(home)
    await writeReport(home)
    seedCheckpoint(home, '1000', dir, 'OLD')
    const originalOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === join(checkpointsRoot(home), '2000.tmp', 'sessions', dir)) {
        vi.spyOn(handle, 'sync').mockRejectedValue(new Error('directory sync failed'))
      }
      return handle
    })
    expect(await runExitCheckpoint({
      home, childPid: CHILD_PID, appVersion: 'test', validate: fakeValidator(), now: () => 2000,
    })).toMatchObject({ kind: 'aborted', reason: 'directory sync failed' })
    expect(readdirSync(checkpointsRoot(home))).toEqual(['1000'])
  })

  it('sweeps stale candidates left by an interrupted earlier capture', async () => {
    const home = makeHome()
    populateHome(home)
    await writeReport(home)
    writeFile(join(checkpointsRoot(home), '999.tmp', 'leftover'), 'x')
    await runExitCheckpoint({ home, childPid: CHILD_PID, appVersion: '1.0.0', validate: fakeValidator(), now: () => 5000 })
    expect(readdirSync(checkpointsRoot(home)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('pruneCheckpoints', () => {
  function commit(home: string, dir: string, sessionIds: string[]): void {
    const manifest: CheckpointManifest = {
      version: 1, id: dir, capturedAt: Number(dir),
      shutdown: { version: 1, recordedAt: 0 },
      files: [],
      sessions: sessionIds.map(sessionId => ({
        sessionId, dir: `--k--/session-${sessionId}`, capturedAt: Number(dir),
        sourceCheckpointId: dir, validator: { appVersion: 'x', sessionFormatVersion: 4 },
      })),
    }
    writeFile(join(home, 'electron', 'checkpoints', dir, 'manifest.json'), JSON.stringify(manifest))
  }

  it('keeps a queued restore target until the request is consumed', async () => {
    const home = makeHome()
    for (const id of ['1000', '2000', '3000', '4000']) commit(home, id, ['a'])
    const root = checkpointsRoot(home)
    await pruneCheckpoints(root, undefined, new Set(['1000']))
    expect(readdirSync(root).sort()).toEqual(['1000', '2000', '3000', '4000'])
    await pruneCheckpoints(root)
    expect(readdirSync(root).sort()).toEqual(['2000', '3000', '4000'])
  })

  it('keeps the newest N and every checkpoint holding a unique verified copy', async () => {
    const home = makeHome()
    // Only 1000 uniquely holds 'lost-session'; 2000's sessions are all covered
    // by newer retained checkpoints, so 2000 is the one deleted.
    commit(home, '1000', ['lost-session'])
    commit(home, '2000', ['a'])
    commit(home, '3000', ['a', 'b'])
    commit(home, '4000', ['a', 'b', 'c'])
    commit(home, '5000', ['a', 'b', 'c', 'd'])
    const root = checkpointsRoot(home)
    await pruneCheckpoints(root)
    expect(readdirSync(root).sort()).toEqual(['1000', '3000', '4000', '5000'])
  })
})

const APP_PATH = fileURLToPath(new URL('..', import.meta.url))
const INSTALL_ANCHOR = join(APP_PATH, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const WORKER_MODULE = join(APP_PATH, 'lib', 'checkpoint', 'validate-worker.js')
const backendAvailable = existsSync(INSTALL_ANCHOR)
  && existsSync(join(fileURLToPath(new URL('../../..', import.meta.url)), 'packages', 'session', 'session-persistence-jsonl', 'lib', 'index.js'))

describe('validateSessionsRoot (real bundled backend)', () => {
  it.skipIf(!backendAvailable)('lists and reads a real session, and drops an unreadable one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-validate-'))
    roots.push(root)
    const req = createRequire(INSTALL_ANCHOR)
    const backend = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href) as { apply: unknown }
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
    await ctx.plugin(backend, { root, compression: 'zstd' })
    const handle = await ctx.sessionPersistence.create({
      version: session.SESSION_FORMAT_VERSION,
      id: session.SessionId('phase2-valid'),
      createdAt: 1,
      cwd: '/work/phase2',
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
    // An unreadable sibling: header admission fails, so listing skips it entirely.
    const corruptDir = join(root, '--work-corrupt--', 'corrupt-9999')
    mkdirSync(corruptDir, { recursive: true })
    writeFileSync(join(corruptDir, 'session.v4.jsonl.zstd'), 'not-zstd-at-all')

    const report = await import('../src/checkpoint/validate.ts').then(module =>
      module.validateSessionsRoot({ sessionsRoot: root, installAnchor: INSTALL_ANCHOR }))
    expect(report.sessionFormatVersion).toBe(session.SESSION_FORMAT_VERSION)
    expect(report.sessions).toHaveLength(1)
    expect(report.sessions[0]?.sessionId).toBe('phase2-valid')
    expect(report.sessions[0]?.ok).toBe(true)
    // The reported dir resolves to the only real session directory on disk.
    const projectDir = readdirSync(root).find(name => name !== '--work-corrupt--')!
    expect(report.sessions[0]?.dir).toBe(`${projectDir}/phase2-valid`)
    expect(existsSync(join(root, ...report.sessions[0]!.dir.split('/')))).toBe(true)
  })

  it.skipIf(!(backendAvailable && existsSync(WORKER_MODULE)))(
    'spawns the validation worker as a child and parses its RESULT line', async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-validate-worker-'))
      roots.push(root)
      mkdirSync(join(root, '--empty--', 'none-0000'), { recursive: true })
      const { runValidationWorker } = await import('../src/checkpoint/worker.ts')
      const report = await runValidationWorker(
        WORKER_MODULE, root, INSTALL_ANCHOR,
        { executable: process.execPath, env: {} },
      )
      expect(report.sessions).toEqual([])
      expect(typeof report.sessionFormatVersion).toBe('number')
    })
})

describe('runValidationWorker result framing', () => {
  const runtime = { executable: process.execPath, env: {} }

  function stubWorker(root: string, script: string): string {
    const fixture = join(root, 'fake-worker.mjs')
    writeFileSync(fixture, script)
    return fixture
  }

  it('does not launch an already aborted validation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-worker-aborted-'))
    roots.push(root)
    const marker = join(root, 'launched')
    const fixture = stubWorker(root, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes')`)
    const { runValidationWorker } = await import('../src/checkpoint/worker.ts')
    await expect(runValidationWorker(fixture, root, join(root, 'anchor'), runtime,
      AbortSignal.abort(new Error('already cancelled')))).rejects.toThrow('already cancelled')
    expect(existsSync(marker)).toBe(false)
  })

  // Windows terminates SIGTERM recipients forcibly; POSIX exercises escalation.
  it.skipIf(process.platform === 'win32')('reaps a worker that ignores cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-worker-cancel-'))
    roots.push(root)
    const ready = join(root, 'ready')
    const fixture = stubWorker(root, `
      import { writeFileSync } from 'node:fs'
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 1000)
      writeFileSync(${JSON.stringify(ready)}, String(process.pid))
    `)
    const controller = new AbortController()
    const { runValidationWorker } = await import('../src/checkpoint/worker.ts')
    let settled = false
    const done = runValidationWorker(fixture, root, join(root, 'anchor'), runtime, controller.signal)
      .catch((error: unknown) => error).finally(() => { settled = true })
    try {
      await expect.poll(() => existsSync(ready), { timeout: 10_000 }).toBe(true)
      controller.abort(new Error('validation cancelled'))
      await expect.poll(() => settled, { timeout: 10_000 }).toBe(true)
      expect(await done).toMatchObject({ message: 'validation cancelled' })
      const pid = Number(readFileSync(ready, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      controller.abort()
      if (!settled && existsSync(ready)) process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL')
      await done
    }
  }, 30_000)

  it('parses a RESULT line split across stdout chunks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-worker-split-'))
    roots.push(root)
    const fixture = stubWorker(root, `
      const report = JSON.stringify({ sessionFormatVersion: 4, sessions: [] })
      process.stdout.write('RESULT ' + report.slice(0, 12))
      setTimeout(() => { process.stdout.write(report.slice(12) + '\\n') }, 30)
    `)
    const { runValidationWorker } = await import('../src/checkpoint/worker.ts')
    const report = await runValidationWorker(fixture, root, join(root, 'anchor'), runtime)
    expect(report).toEqual({ sessionFormatVersion: 4, sessions: [] })
  })

  it('keeps a multibyte character split across chunks intact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-worker-utf8-'))
    roots.push(root)
    const sessionId = 'session-😀-tail'
    const fixture = stubWorker(root, `
      const report = JSON.stringify({ sessionFormatVersion: 4, sessions: [{ sessionId: ${JSON.stringify(sessionId)}, dir: 'd', ok: true }] })
      const line = Buffer.from('RESULT ' + report + '\\n')
      const boundary = line.indexOf(0xF0)
      process.stdout.write(line.subarray(0, boundary + 1))
      setTimeout(() => { process.stdout.write(line.subarray(boundary + 1)) }, 30)
    `)
    const { runValidationWorker } = await import('../src/checkpoint/worker.ts')
    const report = await runValidationWorker(fixture, root, join(root, 'anchor'), runtime)
    expect(report.sessions[0]?.sessionId).toBe(sessionId)
  })

  it('parses a result larger than a single stdout window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-worker-large-'))
    roots.push(root)
    const fixture = stubWorker(root, `
      const sessions = Array.from({ length: 2000 }, (_, i) => ({ sessionId: 's-' + i, dir: 'p/s-' + i, ok: true }))
      process.stdout.write('RESULT ' + JSON.stringify({ sessionFormatVersion: 4, sessions }) + '\\n')
    `)
    const { runValidationWorker } = await import('../src/checkpoint/worker.ts')
    const report = await runValidationWorker(fixture, root, join(root, 'anchor'), runtime)
    expect(report.sessions).toHaveLength(2000)
    expect(report.sessions[1999]?.sessionId).toBe('s-1999')
  })

  it('rejects a malformed result instead of throwing inside the stream callback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-worker-bad-'))
    roots.push(root)
    const fixture = stubWorker(root, 'process.stdout.write("RESULT {not-json\\n")')
    const { runValidationWorker } = await import('../src/checkpoint/worker.ts')
    await expect(runValidationWorker(fixture, root, join(root, 'anchor'), runtime))
      .rejects.toThrow('malformed result')
  })

  it('rejects a worker that exits without a result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-worker-none-'))
    roots.push(root)
    const fixture = stubWorker(root, 'process.stdout.write("noise\\n")')
    const { runValidationWorker } = await import('../src/checkpoint/worker.ts')
    await expect(runValidationWorker(fixture, root, join(root, 'anchor'), runtime))
      .rejects.toThrow('without a result')
  })
})
