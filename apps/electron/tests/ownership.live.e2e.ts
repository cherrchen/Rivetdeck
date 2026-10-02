/** Real built Host watches external CLI package mutations without restarting. */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { ensureRuntimePluginsLinked } from '../src/runtime-plugins.ts'
import { preparePluginPackageManager, resolveBundledPnpmBin } from '../src/plugin-package-manager.ts'
import { spawnHarnessChild } from '../src/runtime.ts'

const app = fileURLToPath(new URL('..', import.meta.url))
const git = '@dsh-electron/dsh-plugin-git'
const ordinary = '@dsh-test/ownership-plugin'

interface InventoryPackage {
  packageName: string
  version: string
  resolvedPath: string
  source: string
  enabled: boolean
  loaderEntries: Array<{ fiberPhase: number | null }>
}

it('retains bundled Git, disposes profile packages, and preserves removal through HMR and restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'electron-live-ownership-'))
  const packageManager = preparePluginPackageManager(home, process.execPath, resolveBundledPnpmBin(app))
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1' }
  const packageEnv = { ...env, PATH: packageManager.envPath }
  const bundledGit = realpathSync(join(app, 'node_modules', git))
  let host: ChildProcess | undefined
  let exited: Promise<unknown> | undefined
  let output = ''
  const inventory = (): InventoryPackage[] => {
    const record = JSON.parse(readFileSync(join(home, 'electron', 'runtime-inventory.json'), 'utf8')) as { packages: InventoryPackage[] }
    return record.packages
  }
  const cli = async (...args: string[]): Promise<void> => {
    const child = spawn(process.execPath, [join(app, 'node_modules', '@deepseek-ai/dsh', 'lib/bin.js'),
      'plugin', '--profile', 'web', ...args, '--config.offline=true', '--config.auto-install-peers=false'], { cwd: home, env: packageEnv, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostic = ''
    child.stdout?.on('data', (chunk) => { diagnostic += String(chunk) })
    child.stderr?.on('data', (chunk) => { diagnostic += String(chunk) })
    const [code, signal] = await once(child, 'close') as [number | null, string | null]
    expect(signal, diagnostic).toBeNull()
    expect(code, diagnostic).toBe(0)
  }
  const start = (): void => {
    output = ''
    host = spawnHarnessChild(process.execPath, ['--expose-internals', join(app, 'lib/host.js'), app,
      join(app, 'runtime/host.patch.yml')], { cwd: home, env })
    exited = once(host, 'exit')
    host.stdout?.on('data', (chunk) => { output += String(chunk) })
    host.stderr?.on('data', (chunk) => { output += String(chunk) })
  }
  const stop = async (): Promise<void> => {
    host?.kill('SIGTERM')
    await exited
    host = undefined
  }
  const settled = async (check: () => void): Promise<void> => {
    let lastError: unknown
    try {
      await expect.poll(() => {
        if (host?.exitCode !== null) throw new Error('Host exited before runtime settlement')
        try { check(); return true } catch (error) { lastError = error; return false }
      }, { timeout: 20_000 }).toBe(true)
    } catch (error) {
      const current = existsSync(join(home, 'electron', 'runtime-inventory.json')) ? inventory() : []
      throw new Error(`${String(lastError)}\n${JSON.stringify(current.find(pkg => pkg.packageName === ordinary))}\n${output.replace(/token=[^\s]+/g, 'token=<redacted>')}`, { cause: error })
    }
  }
  try {
    ensureRuntimePluginsLinked(app, home)
    // link: uses the installed published artifact, with no registry or peer installation.
    await cli('add', `link:${bundledGit}`)
    start()
    await settled(() => {
      expect(output).toContain('dsh web:')
      expect(inventory().find(pkg => pkg.packageName === git)?.resolvedPath).toBe(bundledGit)
    })
    const fixture = join(home, 'plugin-source')
    cpSync(join(app, 'tests/fixtures/ownership-plugin'), fixture, { recursive: true })
    await cli('add', `file:${fixture}`)
    await settled(() => {
      const pkg = inventory().find(pkg => pkg.packageName === ordinary)
      expect(pkg).toMatchObject({ version: '1.5.0', source: 'profile', enabled: true, loaderEntries: [{ fiberPhase: 2 }] })
      expect(pkg?.resolvedPath).toBe(realpathSync(join(home, 'profiles/web/node_modules', ordinary)))
      expect(readFileSync(join(home, 'ownership-events.txt'), 'utf8')).toBe('active 1.5.0\n')
    })
    const updatedFixture = join(home, 'plugin-source-1.6.0')
    cpSync(fixture, updatedFixture, { recursive: true })
    for (const filename of ['package.json', 'index.mjs']) {
      const path = join(updatedFixture, filename)
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('1.5.0', '1.6.0'))
    }
    await cli('add', `file:${updatedFixture}`)
    const installed: unknown = JSON.parse(readFileSync(join(home, 'profiles/web/node_modules', ordinary, 'package.json'), 'utf8'))
    expect(installed).toMatchObject({ version: '1.6.0' })
    await settled(() => {
      expect(inventory().find(pkg => pkg.packageName === ordinary)).toMatchObject({ version: '1.6.0', source: 'profile' })
      expect(readFileSync(join(home, 'ownership-events.txt'), 'utf8')).toBe('active 1.5.0\ndisposed 1.5.0\nactive 1.6.0\n')
    })
    await cli('remove', git)
    await settled(() => {
      const profile = JSON.parse(readFileSync(join(home, 'profiles/web/package.json'), 'utf8')) as { dependencies: Record<string, string> }
      expect((profile.dependencies ?? {})).not.toHaveProperty(git)
      expect(inventory().find(pkg => pkg.packageName === git)).toMatchObject({
        resolvedPath: bundledGit, enabled: true, loaderEntries: [{ fiberPhase: 2 }],
      })
      expect(inventory().find(pkg => pkg.packageName === ordinary)?.enabled).toBe(true)
    })
    await cli('remove', ordinary)
    await settled(() => {
      expect(inventory().some(pkg => pkg.packageName === ordinary)).toBe(false)
      expect(readFileSync(join(home, 'ownership-events.txt'), 'utf8')).toBe('active 1.5.0\ndisposed 1.5.0\nactive 1.6.0\ndisposed 1.6.0\n')
    })
    const patch = join(home, 'profiles/web/cordis.patch.yml')
    writeFileSync(patch, '- id: dsh-plugin-git\n  disabled: true\n')
    await settled(() => { expect(inventory().find(pkg => pkg.packageName === git)?.enabled).toBe(false) })
    writeFileSync(patch, '- id: dsh-plugin-git\n  disabled: false\n')
    await settled(() => {
      expect(inventory().find(pkg => pkg.packageName === git)).toMatchObject({ enabled: true, loaderEntries: [{ fiberPhase: 2 }] })
      expect(inventory().some(pkg => pkg.packageName === ordinary)).toBe(false)
    })
    await stop()
    const manifest = JSON.parse(readFileSync(join(home, 'profiles/web/package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect((manifest.dependencies ?? {})).not.toHaveProperty(git)
    expect((manifest.dependencies ?? {})).not.toHaveProperty(ordinary)
    rmSync(join(home, 'electron/runtime-inventory.json'))
    start()
    await settled(() => {
      expect(output).toContain('dsh web:')
      expect(inventory().find(pkg => pkg.packageName === git)?.resolvedPath).toBe(bundledGit)
      expect(inventory().some(pkg => pkg.packageName === ordinary)).toBe(false)
    })
  } finally {
    await stop()
    rmSync(home, { recursive: true, force: true })
  }
})
