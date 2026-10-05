/** Main-only verified installs. Transport is injected from the policy-owned Electron Session. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { unpackRuntime } from '../../scripts/toolchains/common.mjs'
import { runtimePaths } from './paths.ts'
import type { RuntimeError, RuntimeName } from './domain.ts'

/** Validated pinned archive metadata. */
export interface RuntimeArchive { url: string; sha256: string; archive: string }
/** Policy-owned streaming transport; redirects are checked separately before each request. */
export type RuntimeFetch = (url: string, signal: AbortSignal) => Promise<Response>
/** Failure category for localized UI, with low-level details retained in Main logs. */
export class RuntimeInstallError extends Error {
  constructor(readonly code: RuntimeError, cause: unknown) { super(`desktop runtime ${code}`, { cause }) }
}

/** Execute a bounded runtime verification without inheriting Electron child mode.
 * @param executable Installed interpreter.
 * @param args Verification arguments.
 * @param expected Exact output when validating a version.
 * @returns Resolves after the child exits and passes checks.
 */
export async function verifyCommand(executable: string, args: string[], expected?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.PYTHONHOME
    delete env.PYTHONPATH
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let exceeded = false
    const timer = setTimeout(() => { exceeded = true; child.kill() }, 15_000)
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString('utf8')
      if (output.length > 64 * 1024) { exceeded = true; child.kill() }
    })
    child.stderr.resume()
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (exceeded || code !== 0 || (expected !== undefined && output.trim() !== expected)) reject(new Error(`runtime verification failed: ${executable} ${args.join(' ')}`))
      else resolve()
    })
  })
}

/** Verify executable, version, and required package/import facilities.
 * @param name Selected runtime.
 * @param root Extracted installation.
 * @param version Pinned version.
 * @param platform Current platform.
 * @returns Resolves only for a usable runtime.
 */
export async function verifyRuntime(name: RuntimeName, root: string, version: string, platform: NodeJS.Platform): Promise<void> {
  const paths = runtimePaths(name, root, version, platform)
  if (paths.node !== undefined) {
    for (const path of [paths.node.executable, paths.node.npmCli, paths.node.npxCli]) {
      if (!existsSync(path)) throw new Error(`missing Node runtime file: ${path}`)
    }
    await verifyCommand(paths.node.executable, ['--version'], `v${version}`)
    await verifyCommand(paths.node.executable, [paths.node.npmCli, '--version'])
    await verifyCommand(paths.node.executable, [paths.node.npxCli, '--version'])
  }
  if (paths.python !== undefined) {
    await verifyCommand(paths.python.executable, ['--version'], `Python ${version}`)
    await verifyCommand(paths.python.executable, ['-I', '-c', 'import ssl, sqlite3, ctypes'])
    await verifyCommand(paths.python.executable, ['-I', '-m', 'pip', '--version'])
  }
}

/** Stage, checksum, securely extract, and verify before an immutable rename.
 * @param options Main-owned paths, authority, transport, cancellation, and state callbacks.
 * @returns Resolves after the generation exists; activation is separately persisted by the manager.
 */
export async function installRuntime(options: {
  name: RuntimeName
  version: string
  entry: RuntimeArchive
  staging: string
  destination: string
  platform: NodeJS.Platform
  fetch: RuntimeFetch
  signal: AbortSignal
  phase: (phase: 'downloading' | 'verifying' | 'installing', received?: number, total?: number) => void
  verify?: typeof verifyRuntime
}): Promise<void> {
  const { signal, staging, entry } = options
  let stage: RuntimeError = 'download'
  const archive = join(staging, 'download.pending')
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 })
    options.phase('downloading', 0)
    let url = entry.url
    let response: Response | undefined
    for (let redirects = 0; redirects <= 8; redirects++) {
      if (new URL(url).protocol !== 'https:') throw new Error('runtime downloads require HTTPS')
      response = await options.fetch(url, signal)
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (location === null || redirects === 8) throw new Error('invalid runtime redirect')
      url = new URL(location, url).href
    }
    if (response === undefined || !response.ok || response.body === null) throw new Error(`runtime download HTTP ${response?.status}`)
    const length = Number(response.headers.get('content-length'))
    const total = Number.isFinite(length) && length > 0 ? length : undefined
    let received = 0
    const body = response.body
    async function* chunks() {
      const reader = body.getReader()
      try {
        while (true) {
          signal.throwIfAborted()
          const part = await reader.read()
          if (part.done) break
          received += part.value.length
          options.phase('downloading', received, total)
          yield part.value
        }
      } finally { await reader.cancel(); reader.releaseLock() }
    }
    await pipeline(chunks(), createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal })
    stage = 'checksum'
    options.phase('verifying')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(archive)) {
      signal.throwIfAborted()
      if (!(chunk instanceof Buffer)) throw new Error('runtime archive stream returned invalid bytes')
      hash.update(chunk)
    }
    if (hash.digest('hex') !== entry.sha256) throw new Error('runtime SHA256 mismatch')
    stage = 'archive'
    options.phase('installing')
    const extracted = join(staging, 'runtime')
    await unpackRuntime(archive, entry, extracted)
    signal.throwIfAborted()
    stage = 'verification'
    await (options.verify ?? verifyRuntime)(options.name, extracted, options.version, options.platform)
    signal.throwIfAborted()
    await mkdir(join(options.destination, '..'), { recursive: true, mode: 0o700 })
    await rename(extracted, options.destination)
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
    throw new RuntimeInstallError(signal.aborted ? 'interrupted' : code === 'ENOSPC' ? 'disk' : stage, error)
  } finally { await rm(staging, { recursive: true, force: true }) }
}
