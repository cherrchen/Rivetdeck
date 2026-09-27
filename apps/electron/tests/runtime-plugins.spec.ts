import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
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

  it('links required adapters and the declared npm plugins into profile resolution', () => {
    const harnessHome = mkdtempSync(join(tmpdir(), 'dsh-electron-plugins-'))
    try {
      const runtime = discoverRuntimePluginDirectories(appPath)
      const npmRuntime = discoverRuntimePluginPackages(appPath)
      const ecosystem = discoverEcosystemPluginPackages(appPath)
      expect(runtime.map(plugin => plugin.name).sort()).toEqual([
        '@dsh-electron/dsh-electron-desktop-capabilities',
        '@dsh-electron/dsh-electron-network-subprocess',
      ])
      expect(npmRuntime.map(plugin => plugin.name)).toEqual(['@dsh-electron/dsh-theme-studio'])
      expect(ecosystem.map(plugin => plugin.name)).toEqual(['@dsh-electron/dsh-plugin-git'])
      ensureRuntimePluginsLinked(appPath, harnessHome)
      for (const plugin of [...runtime, ...npmRuntime, ...ecosystem]) {
        expect(readlinkSync(profileModuleLinkPath(harnessHome, plugin.name))).toBe(plugin.rootPath)
        expect(readlinkSync(webProfileModuleLinkPath(harnessHome, plugin.name))).toBe(plugin.rootPath)
      }
      const patch = readFileSync(join(appPath, 'runtime', 'host.patch.yml'), 'utf8')
      expect(patch).not.toContain('desktop-git')
      expect(patch).not.toContain("name: '@dsh-electron/dsh-plugin-git'")
      expect(patch).toContain("name: '@dsh-electron/dsh-electron-desktop-capabilities'")
      expect(patch).not.toContain('desktop-ui-plugins')
      expect(patch).not.toContain('cordis:include')
    } finally {
      rmSync(harnessHome, { recursive: true, force: true })
    }
  })

  it('resolves the declared npm runtime plugin from its installed package artifacts', () => {
    const [plugin] = discoverRuntimePluginPackages(appPath)
    expect(plugin?.version).toBe('0.1.1')
    expect(plugin?.rootPath).toBe(join(appPath, 'node_modules', '@dsh-electron', 'dsh-theme-studio'))
    expect(plugin?.hasClient).toBe(true)
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
