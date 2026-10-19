/** Real Host IPC shutdown and checkpoint commit, including the Windows Core executor. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { prepareCoreProfile } from '../src/ecosystem-profile.ts'
import { preparePluginPackageManager, resolveBundledPnpmBin } from '../src/plugin-package-manager.ts'
import { harnessArguments, resolveHostRuntime, spawnHarnessChild } from '../src/runtime.ts'
import { stopHarness } from '../src/harness/process.ts'
import { mergeMainShutdownFacts, readShutdownReportFile } from '../src/harness/shutdown-report.ts'
import { captureExitCheckpoint } from '../src/checkpoint/index.ts'
import { checkpointsRoot, readManifest } from '../src/checkpoint/manifest.ts'

it('commits a checkpoint after the real Host cooperatively drains over IPC', async () => {
  const appPath = fileURLToPath(new URL('..', import.meta.url))
  const runtime = process.platform === 'win32'
    ? resolveHostRuntime({ appPath, resourcesPath: appPath, packaged: false })
    : { executable: process.execPath, env: {} }
  const home = mkdtempSync(join(tmpdir(), 'desktop-checkpoint-host-'))
  let child: ReturnType<typeof spawnHarnessChild> | undefined
  let closed: Promise<unknown> | undefined
  try {
    const manager = preparePluginPackageManager(home, runtime.executable, resolveBundledPnpmBin(appPath))
    await prepareCoreProfile(appPath, home, {
      command: runtime.executable, args: [resolveBundledPnpmBin(appPath)],
      env: { ...runtime.env, PATH: manager.envPath },
    })
    child = spawnHarnessChild(runtime.executable,
      harnessArguments(appPath, join(appPath, 'lib', 'host.js'), join(appPath, 'runtime', 'host.patch.yml')), {
        ipc: true, cwd: home,
        env: { ...process.env, ...runtime.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1' },
      })
    closed = new Promise<void>((resolve) => { child?.once('close', () => { resolve() }) })
    let spawnError: Error | undefined
    child.once('error', (error) => { spawnError = error })
    let ready = false
    let tail = ''
    child.stdout.on('data', (bytes: Buffer) => {
      tail = (tail + bytes.toString()).slice(-4096)
      if (tail.includes('dsh web:')) ready = true
    })
    // Raw Host output can include authentication URLs, so it stays out of failure diagnostics.
    child.stderr.resume()
    await expect.poll(() => {
      if (spawnError !== undefined) throw spawnError
      return ready
    }, { timeout: 60_000 }).toBe(true)
    const pid = child.pid!
    const stopped = await stopHarness(child)
    await closed
    expect(stopped).toEqual({ signal: null, timeout: false, kill: false, exitCode: 0, signalCode: null })
    await mergeMainShutdownFacts(home, { pid, ...stopped })
    expect(await readShutdownReportFile(home)).toMatchObject({
      host: { pid, reachedReady: true, requestedBy: 'ipc', dispose: 'clean', exitCode: 0 },
    })
    const outcome = await captureExitCheckpoint({
      home, childPid: pid, appPath, resourcesPath: appPath, packaged: false, appVersion: 'test', hostRuntime: runtime,
    })
    expect(outcome.kind, JSON.stringify(outcome)).toBe('committed')
    if (outcome.kind !== 'committed') throw new Error('Clean Host did not commit a checkpoint')
    expect(await readManifest(join(checkpointsRoot(home), outcome.id))).toMatchObject({
      shutdown: { host: { requestedBy: 'ipc', dispose: 'clean' }, main: { timeout: false, kill: false } },
    })
    spawnError = undefined
    // The parent's open IPC channel must not keep a CLI --help exit alive.
    child = spawnHarnessChild(runtime.executable, [
      '--expose-internals', join(appPath, 'lib', 'host.js'), appPath,
      join(appPath, 'runtime', 'host.patch.yml'), '--', '--help',
    ], {
      ipc: true, cwd: home,
      env: { ...process.env, ...runtime.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1' },
    })
    closed = new Promise<void>((resolve) => { child?.once('close', () => { resolve() }) })
    child.once('error', (error) => { spawnError = error })
    child.stdout.resume()
    child.stderr.resume()
    await expect.poll(() => {
      if (spawnError !== undefined) throw spawnError
      return child?.exitCode
    }, { timeout: 30_000 }).toBe(0)
    await closed
    expect(await readShutdownReportFile(home)).toMatchObject({
      host: { requestedBy: 'cli', dispose: 'clean', exitCode: 0 },
    })
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    rmSync(home, { recursive: true, force: true })
  }
}, 120_000)
