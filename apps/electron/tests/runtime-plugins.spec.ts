import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  discoverEcosystemPluginPackages,
  discoverRuntimePluginDirectories,
  discoverRuntimePluginPackages,
  ensureRuntimePluginsLinked,
  profileModuleLinkPath,
  webProfileModuleLinkPath,
} from '../src/runtime-plugins.ts'

const appPath = fileURLToPath(new URL('..', import.meta.url))
const GIT = '@dsh-electron/dsh-plugin-git'

describe('bundled Desktop plugin startup', () => {
  it('shares executable-miss errors with the Host subprocess package', () => {
    // Node loads the built plugin without Vitest's source-package aliases.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { Context } from '@deepseek-ai/cordis'
      import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
      import { DesktopNetworkSubprocessRuntime } from './runtime/plugins/desktop-network-subprocess/lib/index.js'
      const ctx = new Context()
      const provider = new DesktopNetworkSubprocessRuntime(ctx)
      try {
        await assert.rejects(
          provider.resolveExecutable('fish', { PATH: './missing-shell-directory' }),
          SubprocessExecutableNotFoundError,
        )
      } finally {
        await ctx.fiber.dispose()
      }
      console.log('missing shell recognized')
    `], { cwd: appPath, encoding: 'utf8', timeout: 10_000 })
    expect(output.trim()).toBe('missing shell recognized')
  })

  it('links required runtime adapters without taking over ecosystem packages', () => {
    const harnessHome = mkdtempSync(join(tmpdir(), 'dsh-electron-plugins-'))
    try {
      const runtime = discoverRuntimePluginDirectories(appPath)
      const npmRuntime = discoverRuntimePluginPackages(appPath)
      const ecosystem = discoverEcosystemPluginPackages(appPath)
      expect(runtime.map(plugin => plugin.name).sort()).toEqual([
        '@dsh-electron/dsh-electron-desktop-capabilities',
        '@dsh-electron/dsh-electron-network-subprocess',
      ])
      expect(npmRuntime).toEqual([])
      expect(ecosystem.map(plugin => plugin.name)).toEqual([GIT, '@dsh-electron/dsh-theme-studio'])
      ensureRuntimePluginsLinked(appPath, harnessHome)
      for (const plugin of [...runtime, ...npmRuntime]) {
        expect(readlinkSync(profileModuleLinkPath(harnessHome, plugin.name))).toBe(plugin.rootPath)
        expect(readlinkSync(webProfileModuleLinkPath(harnessHome, plugin.name))).toBe(plugin.rootPath)
      }
      for (const plugin of ecosystem) {
        expect(existsSync(profileModuleLinkPath(harnessHome, plugin.name))).toBe(false)
        expect(existsSync(webProfileModuleLinkPath(harnessHome, plugin.name))).toBe(false)
      }
      const patch = readFileSync(join(appPath, 'runtime', 'host.patch.yml'), 'utf8')
      expect(patch).not.toContain('desktop-git')
      expect(patch).not.toContain("name: '@dsh-electron/dsh-plugin-git'")
      expect(patch).toContain("name: '@dsh-electron/dsh-electron-desktop-capabilities'")
    } finally {
      rmSync(harnessHome, { recursive: true, force: true })
    }
  })

  it('resolves Theme Studio from its installed ecosystem artifact', () => {
    const plugin = discoverEcosystemPluginPackages(appPath).find(item => item.name === '@dsh-electron/dsh-theme-studio')
    expect(plugin?.version).toBe('0.1.2')
    expect(plugin?.rootPath).toBe(join(appPath, 'node_modules', '@dsh-electron', 'dsh-theme-studio'))
    expect(plugin?.hasClient).toBe(true)
  })

  it('leaves a real profile-installed ecosystem package untouched', () => {
    const harnessHome = mkdtempSync(join(tmpdir(), 'dsh-electron-physical-'))
    try {
      const link = webProfileModuleLinkPath(harnessHome, GIT)
      mkdirSync(link, { recursive: true })
      writeFileSync(join(link, 'marker.txt'), 'prior install')
      writeFileSync(join(link, 'package.json'), JSON.stringify({ name: GIT, version: '9.9.9' }))
      ensureRuntimePluginsLinked(appPath, harnessHome)
      expect(lstatSync(link).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(link, 'marker.txt'), 'utf8')).toBe('prior install')
      expect(readdirSync(join(harnessHome, 'profiles', 'web', 'node_modules', '@dsh-electron'))
        .some(name => name.startsWith('dsh-plugin-git.desktop-replaced-'))).toBe(false)
    } finally {
      rmSync(harnessHome, { recursive: true, force: true })
    }
  })

  it('validates every artifact before writing profile links', () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'dsh-electron-invalid-artifact-'))
    const harnessHome = mkdtempSync(join(tmpdir(), 'dsh-electron-invalid-home-'))
    try {
      const first = join(appRoot, 'runtime', 'plugins', 'first')
      const second = join(appRoot, 'runtime', 'plugins', 'second')
      mkdirSync(join(first, 'lib'), { recursive: true })
      mkdirSync(second, { recursive: true })
      writeFileSync(join(first, 'package.json'), JSON.stringify({ name: '@test/first', version: '1.0.0' }))
      writeFileSync(join(first, 'lib', 'index.js'), '')
      writeFileSync(join(second, 'package.json'), JSON.stringify({ name: '@test/second', version: '1.0.0' }))
      expect(() => { ensureRuntimePluginsLinked(appRoot, harnessHome) }).toThrow(/missing lib\/index.js/)
      expect(existsSync(profileModuleLinkPath(harnessHome, '@test/first'))).toBe(false)
    } finally {
      rmSync(appRoot, { recursive: true, force: true })
      rmSync(harnessHome, { recursive: true, force: true })
    }
  })

  it('fails loud when a declared npm runtime plugin is not installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-electron-inventory-'))
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ dshElectron: { runtimePlugins: ['@dsh-electron/dsh-missing'] } }),
      )
      expect(() => discoverRuntimePluginPackages(root)).toThrow(
        /runtime plugins: @dsh-electron\/dsh-missing is declared but not installed at /,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
