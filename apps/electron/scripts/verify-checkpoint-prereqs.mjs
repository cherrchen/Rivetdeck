#!/usr/bin/env node
/**
 * Phase-0 evidence script for session checkpoint/restore (docs/electron/session-checkpoint-restore.md).
 * One-off technical validation; not part of the shipped app.
 *
 * Proves, with real bytes and real processes:
 *   (a) the native flock used by SessionWriteLease loads and contends correctly
 *       under plain Node, under Electron's Node mode (ELECTRON_RUN_AS_NODE),
 *       and inside the Electron main process;
 *   (b) the session-persistence-jsonl READ path (list + open 'read' + full read,
 *       including the historical-migration prepare path and related-source reads)
 *       performs zero writes on the inspected tree.
 *
 * Modes (selected by PHASE0_MODE env, so argv parsing stays identical across
 * node / electron-as-node / electron-main):
 *   env            print runtime facts (node version, NAPI level, zstd, platform)
 *   raw-flock      tryLockExclusive on <arg>; PHASE0_ARG = lock file path
 *   lease-hold     acquire session.lock under PHASE0_ARG root; hold until SIGTERM/exit
 *   lease-probe    one-shot acquire under PHASE0_ARG root; 0 ok, 3 contention, 1 other
 *   make-fixture   create real v4 session + v0 fixtures under PHASE0_ARG root
 *   validate       read-path validate sessions under PHASE0_ARG root; print counts
 *   orchestrate    (default) run the full matrix by spawning the above modes
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

// node:zlib's zstd API is probed lazily: the whole point of `env` mode is to
// report whether the current runtime (Electron's Node or plain Node) has it,
// so a missing export must not kill module evaluation.
async function zstdFrame(data) {
  const { constants, zstdCompress } = await import('node:zlib')
  if (typeof zstdCompress !== 'function') {
    throw new Error('node:zlib has no zstdCompress in this runtime')
  }
  return promisify(zstdCompress)(data, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}

const SCRIPT = fileURLToPath(import.meta.url)
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BACKEND_LIB = join(REPO, 'packages/session/session-persistence-jsonl/lib/index.js')
const V0_FIXTURE = join(REPO, 'packages/session/session-persistence-jsonl/tests/fixtures/released-v0-real-shapes.jsonl')
const FLOCK_LIB = join(REPO, 'native/system/packages/entry/lib/flock.js')

const LINE = 'PHASE0 '
const out = (msg) => process.stdout.write(`${LINE}${msg}\n`)
const err = (msg) => process.stderr.write(`${LINE}${msg}\n`)

function fail(message, code = 1) {
  out(`FAIL ${message}`)
  process.exit(code)
}

/** Import the backend bundle and its own copy of cordis (same realpath as the backend sees). */
async function loadBackendModules() {
  if (!existsSync(BACKEND_LIB)) {
    fail(`backend lib missing at ${BACKEND_LIB}; run \`pnpm run build\` first`)
  }
  const backendRequire = createRequire(BACKEND_LIB)
  const backend = await import(pathToFileURL(BACKEND_LIB).href)
  const cordis = await import(pathToFileURL(backendRequire.resolve('@deepseek-ai/cordis')).href)
  const session = await import(pathToFileURL(backendRequire.resolve('@deepseek-ai/dsh-session')).href)
  return { backend, cordis, session }
}

async function mountBackend(root) {
  const { backend: Backend, cordis } = await loadBackendModules()
  const ctx = new cordis.Context()
  await ctx.plugin(Backend, { root, compression: 'zstd' })
  return { ctx, persistence: ctx.sessionPersistence }
}

function leaseHeader(session, id, cwd = '/work/phase0') {
  return {
    version: session.SESSION_FORMAT_VERSION,
    id: session.SessionId(id),
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
}

// --- child modes -------------------------------------------------------------

async function modeEnv() {
  const electron = process.versions.electron ?? null
  const napi = process.versions.napi ?? process.versions.modules ?? null
  const zlib = await import('node:zlib')
  out(`env runtime=${process.env.ELECTRON_RUN_AS_NODE === '1' ? 'electron-node'
    : electron !== null ? 'electron-main' : 'node'} ` +
    `node=${process.version} electron=${electron} napi=${napi} ` +
    `platform=${process.platform}-${process.arch} ` +
    `zstd=${typeof zlib.zstdCompress === 'function'}`)
}

async function modeRawFlock() {
  const target = process.env.PHASE0_ARG
  if (target === undefined) fail('raw-flock needs PHASE0_ARG', 1)
  const { tryLockExclusive } = await import(pathToFileURL(FLOCK_LIB).href)
  const fd = openSync(target, 'w')
  try {
    await tryLockExclusive(fd)
  } catch (error) {
    out(`raw-flock acquire failed code=${error?.code ?? String(error)}`)
    process.exit(1)
  }
  out('raw-flock acquired')
  // Hold briefly so a concurrent probe could contend; callers here only need acquire proof.
  const holdMs = Number(process.env.PHASE0_HOLD_MS ?? '200')
  await new Promise((resolve) => setTimeout(resolve, holdMs))
  process.exit(0)
}

async function acquireLeaseOnce(root) {
  const { ctx, persistence } = await mountBackend(root)
  const { session } = await loadBackendModules()
  const lease = await persistence.acquireWriteLease(leaseHeader(session, 'phase0-lease'))
  return { ctx, lease }
}

async function modeLeaseHold() {
  const root = process.env.PHASE0_ARG
  if (root === undefined) fail('lease-hold needs PHASE0_ARG', 1)
  const { ctx, lease } = await acquireLeaseOnce(root).catch((error) => {
    out(`lease-hold acquire failed ${error?.name ?? ''} code=${error?.code ?? String(error)}`)
    process.exit(1)
  })
  out('lease-hold acquired session.lock')
  // Keep the event loop alive: a pending promise alone does not stop plain Node
  // from exiting (which would release the flock before the probe contends it).
  setInterval(() => {}, 60_000)
  process.on('SIGTERM', () => {
    void lease.release().then(() => ctx.fiber.dispose()).finally(() => process.exit(0))
  })
  await new Promise(() => {})
}

async function modeLeaseProbe() {
  const root = process.env.PHASE0_ARG
  if (root === undefined) fail('lease-probe needs PHASE0_ARG', 1)
  try {
    const { ctx, lease } = await acquireLeaseOnce(root)
    await lease.release()
    await ctx.fiber.dispose()
    out('lease-probe acquired-and-released')
    process.exit(0)
  } catch (error) {
    const name = error?.name ?? 'unknown'
    out(`lease-probe refused ${name} code=${error?.code ?? String(error)}`)
    process.exit(name === 'SessionAlreadyOwnedError' ? 3 : 1)
  }
}

// --- fixtures ----------------------------------------------------------------

// Mirrors projectKey() in packages/session/session-persistence-jsonl/src/format.ts.
// Both encoders must iterate UTF-16 code units (charCodeAt), not code points —
// astral characters escape as two surrogate units upstream.
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (/^[A-Za-z0-9._-]$/.test(ch) && ch !== '~') {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += /^[A-Za-z0-9._-]$/.test(ch) && ch !== '~'
      ? ch
      : '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** Concatenated-frames zstd artifact: frame 1 = exactly the header line, frame 2 = the body. */
async function zstdSessionFile(plaintextLines) {
  const headerLine = `${plaintextLines[0]}\n`
  const body = `${plaintextLines.slice(1).join('\n')}\n`
  return Buffer.concat([await zstdFrame(headerLine), await zstdFrame(body)])
}

async function modeMakeFixture() {
  const root = process.env.PHASE0_ARG
  if (root === undefined) fail('make-fixture needs PHASE0_ARG', 1)
  const { ctx, persistence } = await mountBackend(root)
  const { session } = await loadBackendModules()

  // Session A: real current-generation artifact through the real write path
  // (materialize acquires session.lock via native flock, encodes zstd frames).
  const header = leaseHeader(session, 'phase0-current', '/work/alpha')
  const handle = await persistence.create(header)
  await handle.append([
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    {
      type: 'user/message', seq: 1, time: 1001,
      data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'phase0' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: 2, time: 1002, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  await handle.flush()
  await handle.close()

  // Session B: historical v0 artifact — the repo's intentionally frozen
  // "surface before first step" fixture. The read path must REFUSE it with
  // SessionFormatUnsupportedError without writing (this is the exact failure
  // family the checkpoint detector surfaces in Phase 4).
  const v0Lines = readFileSync(V0_FIXTURE, 'utf8').split('\n').filter((line) => line.length > 0)
  const dirB = join(root, projectKey('/work'), encodeSegment('released-v0-real-shapes'))
  mkdirSync(dirB, { recursive: true })
  writeFileSync(join(dirB, 'session.jsonl.zstd'), await zstdSessionFile(v0Lines))

  // Session C: subagent child of B — exercises related-source reads during B's prepare.
  const childHeader = JSON.stringify({
    type: 'session', version: 0, id: 'released-v0-child', createdAt: 2, cwd: '/work',
    parentSession: 'released-v0-real-shapes', delegationDepth: 1, origin: 'subagent',
  })
  const childLines = [
    childHeader,
    JSON.stringify({ type: 'turn/start', seq: 0, time: 3, data: { turn: 1 } }),
    JSON.stringify({ type: 'turn/end', seq: 1, time: 4, data: { turn: 1, reason: { kind: 'completed' } } }),
  ]
  const dirC = join(root, projectKey('/work'), encodeSegment('released-v0-child'))
  mkdirSync(dirC, { recursive: true })
  writeFileSync(join(dirC, 'session.jsonl.zstd'), await zstdSessionFile(childLines))

  // Session D: migratable v0 artifact — mirrors migrationOneTurnLog() from
  // jsonl.spec.ts (first surface inside the step). Its read goes through
  // prepareStoredMigration, the heaviest read path, and must stay write-free.
  const migratableHeader = JSON.stringify({
    type: 'session', version: 0, id: 'released-v0-migratable', createdAt: 5, cwd: '/work',
    delegationDepth: 0,
  })
  const assistantMessage = {
    id: 'one-turn-assistant', role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'model', provider: 'mock', model: 'mock' },
  }
  const migratableLines = [
    migratableHeader,
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
    JSON.stringify({ type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } }),
    JSON.stringify({ type: 'user/message', seq: 2, time: 3, surfaceOp: 'append',
      data: { id: 'one-turn-user', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }),
    JSON.stringify({ type: 'assistant/chunk', seq: 3, time: 3,
      data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } }),
    JSON.stringify({ type: 'assistant/chunk', seq: 4, time: 3,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' } } }),
    JSON.stringify({ type: 'assistant/chunk', seq: 5, time: 4,
      data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } } } }),
    JSON.stringify({ type: 'assistant/chunk', seq: 6, time: 4,
      data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } } }),
    JSON.stringify({ type: 'assistant/message', seq: 7, time: 4,
      data: { turn: 1, step: 1, message: assistantMessage },
      sourceEventSeqs: [3, 4, 5, 6], surfaceOp: 'append' }),
    JSON.stringify({ type: 'step/end', seq: 8, time: 5, data: { turn: 1, step: 1 } }),
    JSON.stringify({ type: 'turn/end', seq: 9, time: 6, data: { turn: 1, reason: { kind: 'completed' } } }),
  ]
  const dirD = join(root, projectKey('/work'), encodeSegment('released-v0-migratable'))
  mkdirSync(dirD, { recursive: true })
  writeFileSync(join(dirD, 'session.jsonl.zstd'), await zstdSessionFile(migratableLines))

  await ctx.fiber.dispose()
  out(`make-fixture wrote root=${root}`)
  process.exit(0)
}

// Expected outcome per fixture id: 'ok' or the refusing error's `name`.
// A refusal through the read path is evidence too — the checkpoint detector
// surfaces exactly these failures (docs: SessionFormatUnsupportedError entry).
const VALIDATE_EXPECT = new Map([
  ['phase0-current', 'ok'],
  ['released-v0-migratable', 'ok'],
  ['released-v0-child', 'ok'],
  ['released-v0-real-shapes', 'SessionFormatUnsupportedError'],
])

async function modeValidate() {
  const root = process.env.PHASE0_ARG
  if (root === undefined) fail('validate needs PHASE0_ARG', 1)
  const { ctx, persistence } = await mountBackend(root)
  const snapshots = await persistence.list()
  out(`validate listed ${snapshots.length} sessions`)
  const seen = new Map()
  let mismatches = 0
  for (const snap of snapshots) {
    const id = String(snap.header.id)
    let outcome
    try {
      const handle = await persistence.open(id, 'read')
      let offset = 0
      let total = 0
      for (;;) {
        const result = await handle.read(offset)
        if (result.events.length === 0) break
        total += result.events.length
        offset = result.events[result.events.length - 1].seq + 1
      }
      await handle.close()
      outcome = 'ok'
      out(`validate session=${id} events=${total} headerVersion=${snap.header.version}`)
    } catch (error) {
      outcome = error?.name ?? 'unknown'
      out(`validate session=${id} refused ${outcome}: ${String(error?.message ?? error).slice(0, 140)}`)
    }
    seen.set(id, outcome)
    const want = VALIDATE_EXPECT.get(id)
    if (want === undefined || outcome !== want) {
      out(`validate MISMATCH session=${id} got=${outcome} want=${want ?? '<not listed>'}`)
      mismatches += 1
    }
  }
  for (const [id, want] of VALIDATE_EXPECT) {
    if (!seen.has(id)) {
      out(`validate MISSING session=${id} want=${want}`)
      mismatches += 1
    }
  }
  await ctx.fiber.dispose()
  process.exit(mismatches === 0 ? 0 : 2)
}

// --- tree snapshot / diff -----------------------------------------------------

async function snapshotTree(root) {
  const rows = []
  async function walk(dir, rel) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, entry.name)
      const r = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        rows.push(`D ${r}`)
        await walk(p, r)
      } else if (entry.isFile()) {
        const s = await stat(p, { bigint: true })
        const digest = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)
        rows.push(`F ${r} ${s.size} ${s.mtimeNs} ${s.ino} ${digest}`)
      } else {
        rows.push(`O ${r}`)
      }
    }
  }
  try {
    await walk(root, '')
  } catch (error) {
    if (error?.code === 'ENOENT') return ['<absent>']
    throw error
  }
  return rows
}

function diffTrees(before, after) {
  const a = new Set(before)
  const b = new Set(after)
  const added = after.filter((row) => !a.has(row))
  const removed = before.filter((row) => !b.has(row))
  return { added, removed }
}

// --- orchestrator -------------------------------------------------------------

function electronBin() {
  const require = createRequire(join(REPO, 'apps/electron/package.json'))
  return require('electron')
}

/**
 * Run a child mode under a named runtime.
 * runtimes: node | electron-node (ELECTRON_RUN_AS_NODE) | electron-main (real main process).
 * electron-main needs a tiny app shim since `electron <file>` resolves the arg as an app path.
 */
function runChild(runtime, mode, arg, { hold = false, shimDir } = {}) {
  const env = { ...process.env, PHASE0_MODE: mode, PHASE0_ARG: arg }
  let command
  let args
  if (runtime === 'node') {
    command = process.execPath
    args = [SCRIPT]
  } else {
    command = electronBin()
    if (runtime === 'electron-node') {
      env.ELECTRON_RUN_AS_NODE = '1'
      args = [SCRIPT]
    } else {
      // Real Electron main process: a minimal app dir (kept out of `arg`, which
      // may be a file path) whose entry installs exception handlers first —
      // Electron's default uncaught handler shows a modal dialog and would hang
      // a headless probe forever.
      const appDir = shimDir
      mkdirSync(appDir, { recursive: true })
      writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'phase0', type: 'module', main: 'main.mjs' }))
      writeFileSync(join(appDir, 'main.mjs'),
        `process.on('uncaughtException', (e) => { console.error('PHASE0 uncaught', e); process.exit(1) })\n` +
        `process.on('unhandledRejection', (e) => { console.error('PHASE0 rejection', e); process.exit(1) })\n` +
        `const { runPhase0Mode } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})\n` +
        `const code = await runPhase0Mode(process.env.PHASE0_MODE, process.env.PHASE0_ARG)\n` +
        `process.exit(typeof code === 'number' ? code : 0)\n`)
      delete env.ELECTRON_RUN_AS_NODE
      args = [appDir]
    }
  }
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  if (hold) return { child, get stdout() { return stdout }, get stderr() { return stderr } }
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
    child.on('error', (error) => resolve({ code: -1, signal: null, stdout, stderr: `${stderr}\n${String(error)}` }))
  })
}

function waitForLine(getText, needle, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (getText().includes(needle)) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`timeout waiting for ${needle}; got: ${getText().slice(-400)}`))
      }
    }, 25)
  })
}

async function stopHolder(holder) {
  if (holder.child.exitCode !== null) return
  holder.child.kill('SIGTERM')
  await new Promise((resolve) => {
    const t = setTimeout(() => { holder.child.kill('SIGKILL'); resolve() }, 5000)
    holder.child.once('exit', () => { clearTimeout(t); resolve() })
  })
}

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
}

async function checkLeaseMatrix(runtime, dir, shimDir) {
  // Holder acquires session.lock through the real SessionWriteLease path.
  const holder = runChild(runtime, 'lease-hold', dir, { hold: true, shimDir })
  try {
    await waitForLine(() => holder.stdout, 'lease-hold acquired')
  } catch (error) {
    report(`${runtime}: lease acquire`, false, `${error.message} stderr=${holder.stderr.slice(-200)}`)
    await stopHolder(holder)
    return
  }
  report(`${runtime}: lease acquire`, true)

  // Probe while held: must be refused as SessionAlreadyOwnedError (exit 3).
  const probe = await runChild(runtime, 'lease-probe', dir, { shimDir })
  report(`${runtime}: lease contention refused`, probe.code === 3, `exit=${probe.code} ${probe.stdout.trim().slice(-160)}`)

  await stopHolder(holder)

  // Probe after release: must acquire cleanly.
  const probe2 = await runChild(runtime, 'lease-probe', dir, { shimDir })
  report(`${runtime}: lease reacquire after release`, probe2.code === 0, `exit=${probe2.code} ${probe2.stdout.trim().slice(-160)}`)
}

async function checkReadPath(runtime, fixtureRoot, shimDir) {
  const copyRoot = `${fixtureRoot}-copy-${runtime}`
  cpSync(fixtureRoot, copyRoot, { recursive: true })

  const before = await snapshotTree(copyRoot)
  const watchEvents = []
  const watcher = watch(copyRoot, { recursive: true }, (event, name) => { watchEvents.push(`${event}:${name}`) })
  try {
    const run = await runChild(runtime, 'validate', copyRoot, { shimDir })
    // Let fsevents deliver before judging transient writes.
    await new Promise((resolve) => setTimeout(resolve, 800))
    report(`${runtime}: read-path validation completes`, run.code === 0,
      `exit=${run.code} ${run.stdout.trim().split('\n').slice(-3).join(' | ')}`)
    if (run.code !== 0) report(`${runtime}: validate stderr`, false, run.stderr.slice(-300))
  } finally {
    watcher.close()
  }
  const after = await snapshotTree(copyRoot)
  const { added, removed } = diffTrees(before, after)
  const noTreeDelta = added.length === 0 && removed.length === 0
  report(`${runtime}: validation produced zero writes`, noTreeDelta,
    noTreeDelta ? 'tree identical' : `added=${added.join(';')} removed=${removed.join(';')}`)

  // fs.watch is diagnostic: FSEvents on macOS can deliver stale rename events
  // for the fixture copy itself. Only publication-shaped names are failures.
  const suspiciousEvents = watchEvents.filter((event) => /session\.v\d|\.tmp/.test(event))
  report(`${runtime}: no publication-shaped fs events during validation`, suspiciousEvents.length === 0,
    watchEvents.length === 0 ? 'no events' : `${watchEvents.length} event(s), suspicious=${suspiciousEvents.join(';')}`)

  // Explicit guards: no NEW migration publish (session.vN), no staged tmp residue.
  // (A pre-existing session.lock and session.v4.jsonl.zstd travel with the
  // fixture copy — newly added ones are caught by `added` from the tree diff.)
  const tmpResidue = after.filter((row) => /\.tmp/.test(row))
  const published = added.filter((row) => /session\.v\d/.test(row))
  report(`${runtime}: no migration publish / tmp in copy`,
    tmpResidue.length === 0 && published.length === 0,
    [...tmpResidue, ...published].join(';'))
}

async function orchestrate() {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-phase0-'))
  const shimDir = join(scratch, '.electron-main-app')
  process.stdout.write(`phase0 scratch: ${scratch}\n`)
  try {
    // Environment facts in each runtime.
    for (const runtime of ['node', 'electron-node', 'electron-main']) {
      const run = await runChild(runtime, 'env', scratch, { shimDir })
      report(`${runtime}: env probe`, run.code === 0, run.stdout.trim().slice(0, 220))
    }

    // (a) flock: raw addon load + full lease path, per runtime.
    for (const runtime of ['node', 'electron-node', 'electron-main']) {
      const run = await runChild(runtime, 'raw-flock', join(scratch, `raw-${runtime}.lock`), { shimDir })
      report(`${runtime}: raw flock acquire`, run.code === 0, run.stdout.trim().slice(-160))
    }
    for (const runtime of ['node', 'electron-node', 'electron-main']) {
      await checkLeaseMatrix(runtime, join(scratch, `lease-${runtime}`), shimDir)
    }

    // (b) fixture under electron-node (covers write path + flock under Electron's Node).
    const fixtureRoot = join(scratch, 'sessions-live')
    const made = await runChild('electron-node', 'make-fixture', fixtureRoot, { shimDir })
    report('electron-node: fixture create (v4 write path + v0/v0-child artifacts)', made.code === 0,
      made.stdout.trim().slice(-200) + (made.code === 0 ? '' : ` stderr=${made.stderr.slice(-300)}`))
    if (made.code === 0) {
      for (const runtime of ['node', 'electron-node']) {
        await checkReadPath(runtime, fixtureRoot, shimDir)
      }
    }
  } finally {
    const failures = results.filter((row) => !row.ok).length
    process.stdout.write(`\n${results.length - failures}/${results.length} checks passed; scratch ${failures === 0 ? 'removed' : 'kept for inspection'}: ${scratch}\n`)
    if (failures === 0) rmSync(scratch, { recursive: true, force: true })
    process.exit(failures === 0 ? 0 : 1)
  }
}

/** Child-mode dispatch; exported for the electron-main shim. */
export async function runPhase0Mode(mode, arg) {
  switch (mode) {
    case 'env': await modeEnv(); return 0
    case 'raw-flock': await modeRawFlock(); return 0
    case 'lease-hold': await modeLeaseHold(); return 0
    case 'lease-probe': await modeLeaseProbe(); return 0
    case 'make-fixture': await modeMakeFixture(); return 0
    case 'validate': await modeValidate(); return 0
    case 'orchestrate': await orchestrate(); return 0
    default: err(`unknown mode ${String(mode)}`); return 1
  }
}

// Run only when this file is the process entry (node / ELECTRON_RUN_AS_NODE);
// the electron-main shim imports runPhase0Mode instead, so argv[1] differs.
if (process.argv[1] === SCRIPT) {
  const mode = process.env.PHASE0_MODE ?? 'orchestrate'
  runPhase0Mode(mode, process.env.PHASE0_ARG).then(
    (code) => { if (typeof code === 'number' && code !== 0) process.exitCode = code },
    (error) => { err(`fatal ${error?.stack ?? String(error)}`); process.exit(1) },
  )
}
