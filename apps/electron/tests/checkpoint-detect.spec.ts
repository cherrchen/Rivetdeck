import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkpointsRoot,
  type CheckpointFileEntry,
  type CheckpointManifest,
  type CheckpointSessionEntry,
  type CheckpointSessionHeader,
} from '../src/checkpoint/manifest.ts'
import { detectCheckpointDrift, confirmUnreadable, type DriftDetection } from '../src/checkpoint/detect.ts'
import {
  dequeuePendingRestore,
  enqueuePendingRestore,
  listPendingRestores,
} from '../src/checkpoint/pending.ts'
import { detectFormatRefusalFrame } from '../src/checkpoint/refusal.ts'
import { filterIdleWriters, resolveSessionRefusal } from '../src/checkpoint/index.ts'
import type { AcquireSessionLease } from '../src/checkpoint/restore.ts'
import type { ConfirmedUnreadable } from '../src/checkpoint/detect.ts'
import { buildNoCheckpointNotice, buildOrphanedJournalGate, buildRestoreConfirm } from '../src/checkpoint/dialog.ts'
import { en, zh } from '../src/locale.ts'
import type { CheckpointValidationReport } from '../src/checkpoint/capture.ts'

const roots: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-detect-'))
  roots.push(home)
  return home
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

const SESSION_DIR = '--work--/session-aaaa-1111'
const SESSION_ID = 'aaaa-1111'

/** Commit a checkpoint manifest whose `source` stats mirror the live files just written. */
function seedCheckpoint(
  home: string,
  id: string,
  liveFiles: Record<string, string>,
  options?: { sessionId?: string; capturedAt?: number; dropSource?: boolean },
): CheckpointManifest {
  const dir = join(checkpointsRoot(home), id)
  const files: CheckpointFileEntry[] = Object.entries(liveFiles).map(([name, content]) => {
    const rel = `sessions/${SESSION_DIR}/${name}`
    writeFile(join(dir, rel), content)
    const liveStat = statSync(join(home, 'sessions', SESSION_DIR, name), { bigint: true })
    return {
      path: rel,
      origin: 'captured',
      digest: { size: content.length, sha256: sha256(content) },
      ...(options?.dropSource === true
        ? {}
        : { source: { path: rel, size: Number(liveStat.size), mtimeNs: String(liveStat.mtimeNs) } }),
    }
  })
  const sessionId = options?.sessionId ?? SESSION_ID
  const sessions: CheckpointSessionEntry[] = [{
    sessionId,
    dir: SESSION_DIR,
    header: { id: sessionId, cwd: '/work' },
    capturedAt: options?.capturedAt ?? Number(id),
    sourceCheckpointId: id,
    validator: { appVersion: 'prev', sessionFormatVersion: 4 },
  }]
  const manifest: CheckpointManifest = {
    version: 1,
    id,
    capturedAt: Number(id),
    shutdown: { version: 1, recordedAt: 0 },
    files,
    sessions,
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  return manifest
}

function session(home: string, name: string, content: string): void {
  writeFile(join(home, 'sessions', SESSION_DIR, name), content)
}

async function detection(home: string, formatVersion = 4): Promise<DriftDetection | undefined> {
  return detectCheckpointDrift(home, { formatVersion })
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('detectCheckpointDrift', () => {
  it('returns undefined without any committed checkpoint', async () => {
    const home = makeHome()
    expect(await detection(home)).toBeUndefined()
  })

  it('reports no candidates when live stats match the recorded source', async () => {
    const home = makeHome()
    session(home, 'session.jsonl.zstd', 'V0-BYTES')
    session(home, 'session.v4.jsonl.zstd', 'V4-BYTES')
    seedCheckpoint(home, '1000', {
      'session.jsonl.zstd': 'V0-BYTES',
      'session.v4.jsonl.zstd': 'V4-BYTES',
    })
    const found = await detection(home)
    expect(found?.checkpointId).toBe('1000')
    expect(found?.candidates).toEqual([])
  })

  it('flags changed bytes, missing files, and extra generation files', async () => {
    const home = makeHome()
    session(home, 'session.jsonl.zstd', 'V0-BYTES')
    session(home, 'session.v4.jsonl.zstd', 'V4-BYTES')
    seedCheckpoint(home, '1000', {
      'session.jsonl.zstd': 'V0-BYTES',
      'session.v4.jsonl.zstd': 'V4-BYTES',
    })
    // Foreign append: same-generation file grows.
    session(home, 'session.v4.jsonl.zstd', 'V4-BYTES-WITH-APPEND')
    // Foreign publish: a new generation name appears.
    session(home, 'session.v9.jsonl.zstd', 'V9-BYTES')
    const found = await detection(home)
    const candidate = found?.candidates[0]
    expect(candidate?.sessionId).toBe(SESSION_ID)
    expect(candidate?.reasons).toContain('changed')
    expect(candidate?.reasons).toContain('extra')
    expect(candidate?.reasons).toContain('newer-generation')
    expect(candidate?.newerGeneration).toBe(9)
  })

  it('flags a deleted session directory as missing', async () => {
    const home = makeHome()
    session(home, 'session.v4.jsonl.zstd', 'V4-BYTES')
    seedCheckpoint(home, '1000', { 'session.v4.jsonl.zstd': 'V4-BYTES' })
    rmSync(join(home, 'sessions', SESSION_DIR), { recursive: true })
    const found = await detection(home)
    expect(found?.candidates[0]?.reasons).toEqual(['missing'])
  })

  it('does not flag a file whose live bytes match the checkpoint digest (post-restore steady state)', async () => {
    const home = makeHome()
    session(home, 'session.v4.jsonl.zstd', 'RESTORED-BYTES')
    seedCheckpoint(home, '1000', { 'session.v4.jsonl.zstd': 'RESTORED-BYTES' })
    // Simulate the restore outcome: identical bytes, different mtime.
    utimesSync(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'), 0, 1_800_000_000)
    const found = await detection(home)
    expect(found?.candidates).toEqual([])
  })

  it('ignores drift in non-session covered files such as session_projcache', async () => {
    const home = makeHome()
    session(home, 'session.v4.jsonl.zstd', 'V4-BYTES')
    const dir = join(checkpointsRoot(home), '1000')
    writeFile(join(dir, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'), 'V4-BYTES')
    writeFile(join(dir, 'storages', 'session_projcache', 'sessions', 'aaaa-1111.json'), 'row-old')
    const liveStat = statSync(join(home, 'sessions', SESSION_DIR, 'session.v4.jsonl.zstd'), { bigint: true })
    const manifest: CheckpointManifest = {
      version: 1,
      id: '1000',
      capturedAt: 1000,
      shutdown: { version: 1, recordedAt: 0 },
      files: [
        {
          path: `sessions/${SESSION_DIR}/session.v4.jsonl.zstd`,
          origin: 'captured',
          digest: { size: 8, sha256: sha256('V4-BYTES') },
          source: { path: `sessions/${SESSION_DIR}/session.v4.jsonl.zstd`, size: Number(liveStat.size), mtimeNs: String(liveStat.mtimeNs) },
        },
        {
          path: 'storages/session_projcache/sessions/aaaa-1111.json',
          origin: 'captured',
          digest: { size: 7, sha256: sha256('row-old') },
          source: { path: 'storages/session_projcache/sessions/aaaa-1111.json', size: 7, mtimeNs: '1' },
        },
      ],
      sessions: [{
        sessionId: SESSION_ID, dir: SESSION_DIR, capturedAt: 1000,
        sourceCheckpointId: '1000', validator: { appVersion: 'x', sessionFormatVersion: 4 },
      }],
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    // projcache legitimately rewrites every run; it must not surface as drift.
    writeFile(join(home, 'storages', 'session_projcache', 'sessions', 'aaaa-1111.json'), 'row-new-longer')
    const found = await detection(home)
    expect(found?.candidates).toEqual([])
  })

  it('does not flag generation files at or below the bundled version', async () => {
    const home = makeHome()
    session(home, 'session.v4.jsonl.zstd', 'V4-BYTES')
    seedCheckpoint(home, '1000', { 'session.v4.jsonl.zstd': 'V4-BYTES' })
    // A compatible foreign `session.v4` successor is `extra` but not `newer-generation`.
    session(home, 'session.v3.jsonl.zstd', 'V3-BYTES')
    const found = await detection(home)
    expect(found?.candidates[0]?.reasons).toEqual(['extra'])
    expect(found?.candidates[0]?.newerGeneration).toBeUndefined()
  })
})

describe('confirmUnreadable', () => {
  it('confirms only candidates that fail the live read path', async () => {
    const home = makeHome()
    session(home, 'session.v4.jsonl.zstd', 'V4-BYTES')
    const manifest = seedCheckpoint(home, '1000', { 'session.v4.jsonl.zstd': 'V4-BYTES' })
    session(home, 'session.v4.jsonl.zstd', 'POLLUTED')
    const found = await detection(home)
    const report = (ok: boolean): CheckpointValidationReport => ({
      sessionFormatVersion: 4,
      sessions: [{ sessionId: SESSION_ID, dir: SESSION_DIR, ok, ...(ok ? {} : { error: 'refusal' }) }],
    })
    // Compatible foreign writes still read cleanly → silent.
    expect(confirmUnreadable(found!, report(true))).toEqual([])
    const unreadable = confirmUnreadable(found!, report(false))
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0]?.error).toBe('refusal')
    // A session absent from the report (listing refused it) is unreadable too.
    expect(confirmUnreadable(found!, { sessionFormatVersion: 4, sessions: [] })).toHaveLength(1)
    expect(manifest.sessions[0]?.sessionId).toBe(SESSION_ID)
  })
})

describe('pending restores', () => {
  it('queues, dedupes, and dequeues requests atomically', async () => {
    const home = makeHome()
    await enqueuePendingRestore(home, 'one')
    await enqueuePendingRestore(home, 'two')
    await enqueuePendingRestore(home, 'one')
    const first = await listPendingRestores(home)
    expect(first.map(request => request.sessionId).sort()).toEqual(['one', 'two'])
    await dequeuePendingRestore(home, 'one')
    expect((await listPendingRestores(home)).map(request => request.sessionId)).toEqual(['two'])
    await dequeuePendingRestore(home, 'two')
    expect(await listPendingRestores(home)).toEqual([])
    expect(existsSync(join(home, 'electron', 'pending-restore.json'))).toBe(false)
  })

  it('keeps unprocessed requests when a mid-queue dequeue never runs', async () => {
    const home = makeHome()
    await enqueuePendingRestore(home, 'one')
    await enqueuePendingRestore(home, 'two')
    await dequeuePendingRestore(home, 'one')
    expect((await listPendingRestores(home)).map(request => request.sessionId)).toEqual(['two'])
    // A request enqueued between listing and dequeue survives the rewrite.
    await enqueuePendingRestore(home, 'three')
    await dequeuePendingRestore(home, 'two')
    expect((await listPendingRestores(home)).map(request => request.sessionId)).toEqual(['three'])
  })

  it('tolerates a corrupt pending file', async () => {
    const home = makeHome()
    writeFile(join(home, 'electron', 'pending-restore.json'), 'not-json')
    expect(await listPendingRestores(home)).toEqual([])
  })
})

describe('detectFormatRefusalFrame', () => {
  const rawLog = '(raw log: /home/u/.dsh/sessions/--work--/session-aaaa-1111/session.v5.jsonl.zstd)'
  // Messages below are verbatim copies of the upstream refusal text in
  // packages/session/session-persistence/src/{errors,storage-contract}.ts.
  it('extracts the raw session id from a version-refusal frame', () => {
    const frame = JSON.stringify({
      type: 'error',
      streamId: 's1',
      error: {
        code: 'gateway/internal',
        message: `session "aaaa-1111" uses log format v5, but this harness reads only v4: the log was written by a newer harness — upgrade the harness to open it ${rawLog}`,
        details: {},
      },
    })
    const hit = detectFormatRefusalFrame(frame)
    expect(hit?.sessionId).toBe('aaaa-1111')
    expect(hit?.dirTail).toBe('session-aaaa-1111')
  })

  it('extracts the session id from an unknown-event refusal', () => {
    const frame = JSON.stringify({
      type: 'error',
      streamId: 's2',
      error: {
        code: 'gateway/internal',
        message: `session "aaaa-1111" contains event type "job/registered" (seq 24) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness ${rawLog}`,
        details: {},
      },
    })
    const hit = detectFormatRefusalFrame(frame)
    expect(hit?.sessionId).toBe('aaaa-1111')
    expect(hit?.dirTail).toBe('session-aaaa-1111')
  })

  it('extracts the session id from the retired request/header refusal', () => {
    const frame = JSON.stringify({
      type: 'error',
      streamId: 's3',
      error: {
        code: 'gateway/internal',
        message: `session "aaaa-1111" contains a request/header event (seq 7) with the unsupported legacy reason "fallback"; refusing to interpret the log — it was written by a retired pre-release harness ${rawLog}`,
        details: {},
      },
    })
    const hit = detectFormatRefusalFrame(frame)
    expect(hit?.sessionId).toBe('aaaa-1111')
    expect(hit?.dirTail).toBe('session-aaaa-1111')
  })

  it('ignores corruption reports, unrelated frames, item traffic, and malformed payloads', () => {
    // A malformed-header report carries the same `raw log:` suffix but is
    // corruption, not a format refusal.
    expect(detectFormatRefusalFrame(JSON.stringify({
      type: 'error', streamId: 's4',
      error: { code: 'gateway/internal', message: `session "aaaa-1111": stored log has a malformed header ${rawLog}`, details: {} },
    }))).toBeUndefined()
    expect(detectFormatRefusalFrame(JSON.stringify({ type: 'item', streamId: 's', value: 1 }))).toBeUndefined()
    expect(detectFormatRefusalFrame(JSON.stringify({ type: 'error', streamId: 's', error: { code: 'session/not-found', message: 'gone', details: {} } }))).toBeUndefined()
    expect(detectFormatRefusalFrame('not json')).toBeUndefined()
    expect(detectFormatRefusalFrame(JSON.stringify({ type: 'error', streamId: 's', error: { code: 'gateway/internal', message: 'generic failure', details: {} } }))).toBeUndefined()
  })
})

describe('resolveSessionRefusal', () => {
  it('matches by session id and by encoded dir tail', async () => {
    const home = makeHome()
    session(home, 'session.v4.jsonl.zstd', 'V4-BYTES')
    seedCheckpoint(home, '1000', { 'session.v4.jsonl.zstd': 'V4-BYTES' })
    const byId = await resolveSessionRefusal(home, { sessionId: SESSION_ID })
    expect(byId?.checkpointId).toBe('1000')
    expect(byId?.entry.sessionId).toBe(SESSION_ID)
    const byTail = await resolveSessionRefusal(home, { dirTail: 'session-aaaa-1111' })
    expect(byTail?.entry.sessionId).toBe(SESSION_ID)
    expect(await resolveSessionRefusal(home, { sessionId: 'other' })).toBeUndefined()
    expect(await resolveSessionRefusal(home, {})).toBeUndefined()
  })
})

describe('restore dialog copy', () => {
  const facts = {
    sessionId: SESSION_ID,
    capturedAt: 1_700_000_000_000,
    memberCount: 2,
    quarantine: '/home/u/.dsh/electron/quarantine',
    requiresRelaunch: false,
    productName: 'Rivetdeck',
  }

  it('names the checkpoint time, hidden range, quarantine, precondition, and limits', () => {
    const spec = buildRestoreConfirm(en, 'en', facts)
    expect(spec.buttons).toEqual(['Restore Now', 'Not Now'])
    expect(spec.message).toContain('"aaaa-1111"')
    expect(spec.message).toContain('Rivetdeck')
    expect(spec.detail).toContain('quarantine at /home/u/.dsh/electron/quarantine')
    expect(spec.detail).toContain('other DeepSeek Harness or Rivetdeck instance')
    expect(spec.detail).toContain('workspace files')
    expect(spec.detail).toContain('related subagent sessions')
    const relaunch = buildRestoreConfirm(en, 'en', { ...facts, requiresRelaunch: true })
    expect(relaunch.buttons[0]).toBe('Restore and Relaunch')
  })

  it('covers every key in zh and renders the no-checkpoint notice', () => {
    const spec = buildRestoreConfirm(zh, 'zh-CN', facts)
    expect(spec.buttons[0]).toBe('立即恢复')
    expect(spec.detail).toContain('检查点')
    const notice = buildNoCheckpointNotice(en, 'aaaa-1111')
    expect(notice.message).toContain('no verified checkpoint copy exists')
  })

  it('gates an orphaned intent journal on abandon, keep, or quit — keep is the default', () => {
    const spec = buildOrphanedJournalGate(en, { checkpointId: '1000', quarantine: '/q' })
    expect(spec.buttons).toEqual(['Abandon Restore', 'Keep Pending', 'Quit'])
    expect(spec.defaultId).toBe(1)
    expect(spec.cancelId).toBe(2)
    expect(spec.message).toContain('1000')
    expect(spec.detail).toContain('/q')
    expect(buildOrphanedJournalGate(zh, { checkpointId: '1000', quarantine: '/q' }).buttons[0]).toBe('放弃恢复')
  })
})

describe('filterIdleWriters', () => {
  const HEADER: CheckpointSessionHeader = { id: 'aaaa-1111', cwd: '/work', isSeeded: false, delegationDepth: 0 }

  function candidate(dir: string, header?: CheckpointSessionHeader): ConfirmedUnreadable {
    return {
      sessionId: dir,
      dir,
      entry: {
        sessionId: dir,
        dir,
        capturedAt: 0,
        sourceCheckpointId: '1000',
        validator: { appVersion: '0.2.0', sessionFormatVersion: 4 },
        ...(header === undefined ? {} : { header }),
      },
      reasons: ['changed'],
      newerGeneration: undefined,
      error: undefined,
    }
  }

  it('keeps candidates whose write lease is free and drops held or unleasable ones', async () => {
    const held = new Set(['--work--/held'])
    const acquire: AcquireSessionLease = async (subject) => {
      if (held.has(subject.dir)) {
        const error = new Error('already owned')
        error.name = 'SessionAlreadyOwnedError'
        throw error
      }
      return { release: async () => undefined }
    }
    const kept = await filterIdleWriters([
      candidate('--work--/free', HEADER),
      candidate('--work--/held', { ...HEADER, id: 'held' }),
      candidate('--work--/no-header'),
    ], acquire)
    expect(kept.map(item => item.dir)).toEqual(['--work--/free'])
  })
})
