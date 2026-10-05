import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Readable } from 'node:stream'
import {
  HARNESS_STARTUP_BUFFER_LIMIT,
  harnessArguments,
  parseHarnessReadyUrl,
  resolveDshBin,
  resolveHarnessHome,
  resolveHostModule,
  resolveHostRuntime,
  scanHarnessStartupChunk,
  spawnHarnessChild,
} from '../src/runtime.ts'

describe('Electron Harness runtime', () => {
  it('stores Harness state below the operating-system user home', () => {
    expect(resolveHarnessHome('/Users/person').replaceAll('\\', '/')).toBe('/Users/person/.dsh')
    expect(resolveHarnessHome('C:\\Users\\person').replaceAll('\\', '/')).toBe('C:/Users/person/.dsh')
  })

  it('resolves the dsh executable below the application root', () => {
    expect(resolveDshBin('/app/root').replaceAll('\\', '/')).toBe(
      '/app/root/node_modules/@deepseek-ai/dsh/lib/bin.js',
    )
  })

  it('resolves the Desktop Host module below the application root', () => {
    expect(resolveHostModule('/app/root').replaceAll('\\', '/')).toBe('/app/root/lib/host.js')
  })

  it('launches the Desktop Host entry with the ownership overlay', () => {
    expect(harnessArguments('/app', '/app/lib/host.js', '/data/overlay.yml')).toEqual([
      '--expose-internals',
      '/app/lib/host.js',
      '/app',
      '/data/overlay.yml',
      '--',
      '--port',
      '0',
      '--no-open',
    ])
  })

  it('parses the upstream readiness line after preceding output', () => {
    expect(parseHarnessReadyUrl('booting\ndsh web: http://127.0.0.1:43127\n')).toBe(
      'http://127.0.0.1:43127',
    )
    expect(parseHarnessReadyUrl('dsh web: http://127.0.0.1:43127/?token=abc_123-XYZ\n')).toBe(
      'http://127.0.0.1:43127/?token=abc_123-XYZ',
    )
  })

  it('waits for a complete valid loopback readiness line', () => {
    expect(parseHarnessReadyUrl('dsh web: http://127.0.0.1:')).toBeUndefined()
    expect(parseHarnessReadyUrl('dsh web: http://0.0.0.0:3080\n')).toBeUndefined()
    expect(parseHarnessReadyUrl('dsh web: http://127.0.0.1:70000\n')).toBeUndefined()
    expect(parseHarnessReadyUrl('dsh web: http://127.0.0.1:3080/?token=\n')).toBeUndefined()
  })

  it('drops the handshake buffer after the readiness URL and ignores later chunks', () => {
    const scan = { output: '', settled: false }
    expect(scanHarnessStartupChunk(scan, 'booting\n')).toBeUndefined()
    expect(scan.output.length).toBeGreaterThan(0)
    expect(scanHarnessStartupChunk(scan, 'dsh web: http://127.0.0.1:43127\n')).toBe(
      'http://127.0.0.1:43127',
    )
    expect(scan.settled).toBe(true)
    expect(scan.output).toBe('')
    expect(scanHarnessStartupChunk(scan, 'info: still running\n')).toBeUndefined()
    expect(scan.output).toBe('')
  })

  it('retains only the newest handshake window before the readiness line', () => {
    const scan = { output: '', settled: false }
    expect(scanHarnessStartupChunk(scan, `${'x'.repeat(HARNESS_STARTUP_BUFFER_LIMIT + 8)}\n`)).toBeUndefined()
    expect(scan.output.length).toBe(HARNESS_STARTUP_BUFFER_LIMIT)
    expect(scanHarnessStartupChunk(scan, 'dsh web: http://127.0.0.1:43127\n')).toBe(
      'http://127.0.0.1:43127',
    )
  })
})

describe('Host runtime resolution', () => {
  const packagedNode = join('/resources', 'core-runtime', 'node.exe')
  const preparedNode = join('/app', '.electron-build', 'core-runtime', 'win32-x64', 'node.exe')

  it('keeps Electron as the Host executable outside Windows', () => {
    expect(resolveHostRuntime({
      appPath: '/app', resourcesPath: '/resources', packaged: true, platform: 'darwin', exists: () => false,
    })).toEqual({ executable: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } })
  })

  it('uses the packaged Node.js on Windows without Electron child mode', () => {
    expect(resolveHostRuntime({
      appPath: '/app',
      resourcesPath: '/resources',
      packaged: true,
      platform: 'win32',
      arch: 'x64',
      exists: path => path === packagedNode,
    })).toEqual({ executable: packagedNode, env: {} })
  })

  it('uses the prepared build-time Node.js for an unpackaged Windows run', () => {
    expect(resolveHostRuntime({
      appPath: '/app',
      resourcesPath: '/resources',
      packaged: false,
      platform: 'win32',
      arch: 'x64',
      exists: path => path === preparedNode,
    })).toEqual({ executable: preparedNode, env: {} })
  })

  it('prefers an explicit override over both locations', () => {
    expect(resolveHostRuntime({
      appPath: '/app',
      resourcesPath: '/resources',
      packaged: true,
      platform: 'win32',
      arch: 'x64',
      override: 'C:\\tools\\node.exe',
      exists: () => true,
    })).toEqual({ executable: 'C:\\tools\\node.exe', env: {} })
  })

  it('rejects an override that names no existing executable', () => {
    expect(() => resolveHostRuntime({
      appPath: '/app',
      resourcesPath: '/resources',
      packaged: true,
      platform: 'win32',
      arch: 'x64',
      override: 'C:\\tools\\node.exe',
      exists: () => false,
    })).toThrow(/DSH_ELECTRON_NODE_BINARY/u)
  })

  it('fails loudly when Windows has no prepared Node.js', () => {
    expect(() => resolveHostRuntime({
      appPath: '/app',
      resourcesPath: '/resources',
      packaged: false,
      platform: 'win32',
      arch: 'x64',
      exists: () => false,
    })).toThrow(/prepare:core/u)
  })
})

/**
 * The child's own console device in the Win32 device namespace. The DOS alias `CONOUT$` is not
 * openable through `fs`: the path is resolved and rewritten into the `\\?\` namespace first, where
 * it names a regular file, exactly like `NUL`.
 */
const CONSOLE_DEVICE = String.raw`\\.\CONOUT$`

/** Reads stdin to end of stream and reports whether the child owns a console. */
const HOST_CHILD_PROBE = [
  "const fs = require('node:fs')",
  'const bytes = fs.readSync(0, Buffer.alloc(1), 0, 1, null)',
  'let ownsConsole = false',
  `try { fs.closeSync(fs.openSync(${JSON.stringify(CONSOLE_DEVICE)}, 'r+')); ownsConsole = true } catch {}`,
  'process.stdout.write(JSON.stringify({ bytes, ownsConsole }))',
].join(';')

/**
 * Read one probe child's stdout report.
 * @param child - Child started by the launch under test.
 * @returns Stdin byte count and console ownership.
 */
async function probeHostChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<{ bytes: number; ownsConsole: boolean }> {
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  await new Promise(resolve => child.once('close', resolve))
  return JSON.parse(stdout) as { bytes: number; ownsConsole: boolean }
}

describe('supervised Host console', () => {
  it('starts the Host child with an exhausted stdin and piped logs', async () => {
    const child = spawnHarnessChild(process.execPath, ['-e', HOST_CHILD_PROBE], { cwd: tmpdir() })
    expect(child.stdin).toBeNull()
    await expect(probeHostChild(child)).resolves.toMatchObject({ bytes: 0 })
  })

  it.runIf(process.platform === 'win32')('gives the spawned child a console, unlike a console-less launch', async () => {
    const owned = await probeHostChild(spawnHarnessChild(process.execPath, ['-e', HOST_CHILD_PROBE], { cwd: tmpdir() }))
    // Control: `windowsHide` alone keeps the child attached to the parent's console on a runner
    // whose own process tree has one; `DETACHED_PROCESS` is the launch flag that carries no console
    // attachment at all, so the probe reports the absence of a console instead of always succeeding.
    const detached = await probeHostChild(spawn(process.execPath, ['-e', HOST_CHILD_PROBE], {
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }))
    expect(owned.ownsConsole).toBe(true)
    expect(detached.ownsConsole).toBe(false)
  })
})


describe('Windows Core executor', () => {
  it.runIf(process.platform === 'win32' && process.env.DSH_ELECTRON_CORE_SMOKE === '1')(
    'owns a hidden console independently from managed Node and Python', async () => {
      const runtime = resolveHostRuntime({
        appPath: join(import.meta.dirname, '..'), resourcesPath: '/unused', packaged: false,
      })
      expect(runtime.executable).toContain('core-runtime')
      expect(runtime.env).toEqual({})
      await expect(probeHostChild(spawnHarnessChild(runtime.executable, ['-e', HOST_CHILD_PROBE], { cwd: tmpdir() })))
        .resolves.toMatchObject({ bytes: 0, ownsConsole: true })
    },
  )
})
