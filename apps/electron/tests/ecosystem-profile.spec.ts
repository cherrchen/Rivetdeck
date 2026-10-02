import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initProfile, PROFILE_TEMPLATES, readProfileManifest, resolveProfileDir, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { runPluginCommand } from '@deepseek-ai/dsh-plugin-manager/operations'
import { hasLegacyDesktopLink, prepareCoreProfile, prepareEcosystemProfile, WEB_PROFILE_NAME } from '../src/ecosystem-profile.ts'
import { prepareHostProfileProjection, resolveHostProfileDir } from '../src/host-profile.ts'
import { discoverEcosystemPluginPackages } from '../src/runtime-plugins.ts'

vi.mock('@deepseek-ai/dsh-plugin-manager/operations', () => ({ runPluginCommand: vi.fn() }))

const appPath = fileURLToPath(new URL('..', import.meta.url))
const GIT = '@dsh-electron/dsh-plugin-git'
const THEME = '@dsh-electron/dsh-theme-studio'
const manager = { command: '/bundled/node', args: ['/bundled/pnpm.cjs'], env: { PATH: '/bundled' } }
const packageResult = { exitCode: 0, output: '', truncated: false, logPath: '/tmp/pnpm.log' }
const operation = vi.mocked(runPluginCommand)

beforeEach(() => { operation.mockReset(); operation.mockResolvedValue(packageResult) })

function fixture(): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-electron-ecosystem-'))
  return { home, dir: resolveProfileDir(WEB_PROFILE_NAME, home) }
}

function profileWithGit(dir: string, version: string, enabled: boolean): void {
  const template = PROFILE_TEMPLATES[WEB_PROFILE_NAME]
  if (template === undefined) throw new Error('web template missing')
  initProfile(dir, template.bundles)
  const manifest = readProfileManifest('dsh', dir)
  writeProfileManifest(dir, {
    ...manifest,
    dependencies: { ...manifest.dependencies, [GIT]: version, [THEME]: '0.1.3' },
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [
      ...(manifest.dsh?.profile?.bundles ?? []), ...enabled ? [GIT] : [],
    ] } },
  })
  const theme = join(dir, 'node_modules', ...THEME.split('/'))
  mkdirSync(theme, { recursive: true })
  writeFileSync(join(theme, 'package.json'), JSON.stringify({ name: THEME, version: '0.1.3' }))
}

describe('ecosystem profile ownership', () => {
  it('initializes an offline Core profile independently of ecosystem preinstallation', async () => {
    const { home, dir } = fixture()
    try {
      operation.mockImplementation(async () => {
        initProfile(dir, PROFILE_TEMPLATES[WEB_PROFILE_NAME]!.bundles)
        return packageResult
      })
      await prepareCoreProfile(appPath, home, manager)
      expect(operation).toHaveBeenCalledWith(expect.objectContaining({ home }), ['install', '--offline', '--config.auto-install-peers=false'], expect.objectContaining(manager))
      expect(readProfileManifest('dsh', dir).dependencies).toEqual({})
      expect(existsSync(join(home, 'electron', 'ecosystem-preinstalled'))).toBe(false)
      operation.mockClear()
      await prepareCoreProfile(appPath, home, manager)
      expect(operation).not.toHaveBeenCalled()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  it('asks the shared dsh plugin operation to preinstall missing packages once', async () => {
    const { home, dir } = fixture()
    try {
      operation.mockImplementation(async () => {
        profileWithGit(dir, '0.2.4', true)
        const git = join(dir, 'node_modules', ...GIT.split('/'))
        mkdirSync(git, { recursive: true })
        writeFileSync(join(git, 'package.json'), JSON.stringify({ name: GIT, version: '0.2.4' }))
        return packageResult
      })
      await prepareEcosystemProfile(appPath, home, manager)
      expect(operation).toHaveBeenCalledWith(expect.objectContaining({ profile: WEB_PROFILE_NAME, home }), [
        'add', `${GIT}@0.2.4`, `${THEME}@0.1.3`,
      ], expect.objectContaining({ ...manager, execution: 'service' }))
      expect(readProfileManifest('dsh', dir).dependencies?.[GIT]).toBe('0.2.4')
      expect(existsSync(join(home, 'electron', 'ecosystem-preinstalled'))).toBe(true)
      operation.mockClear()
      await prepareEcosystemProfile(appPath, home, manager)
      expect(operation).not.toHaveBeenCalled()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('does not record a completed preinstall when the package operation fails', async () => {
    const { home } = fixture()
    try {
      operation.mockResolvedValue({ ...packageResult, exitCode: 1, output: 'registry unavailable' })
      await expect(prepareEcosystemProfile(appPath, home, manager)).rejects.toThrow('registry unavailable')
      expect(existsSync(join(home, 'electron', 'ecosystem-preinstalled'))).toBe(false)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('keeps the profile version and disabled activation while Desktop resolves its bundled copy', async () => {
    const { home, dir } = fixture()
    try {
      profileWithGit(dir, '0.3.1', false)
      const profileGit = join(dir, 'node_modules', ...GIT.split('/'))
      mkdirSync(profileGit, { recursive: true })
      writeFileSync(join(profileGit, 'package.json'), JSON.stringify({ name: GIT, version: '0.3.1' }))
      await prepareEcosystemProfile(appPath, home, manager)
      expect(operation).not.toHaveBeenCalled()
      expect(readProfileManifest('dsh', dir).dsh?.profile?.bundles).not.toContain(GIT)
      const hostDir = prepareHostProfileProjection(appPath, home)
      const plugin = discoverEcosystemPluginPackages(appPath).find(item => item.name === GIT)
      expect(plugin).toBeDefined()
      expect(hostDir).toBe(resolveHostProfileDir(home))
      expect(readlinkSync(join(hostDir!, 'node_modules', ...GIT.split('/')))).toBe(plugin!.rootPath)
      expect(readProfileManifest('dsh', profileGit).version).toBe('0.3.1')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('repairs an old Desktop link through the package manager', async () => {
    const { home, dir } = fixture()
    try {
      profileWithGit(dir, '0.3.1', true)
      const plugin = discoverEcosystemPluginPackages(appPath).find(item => item.name === GIT)
      if (plugin === undefined) throw new Error('Git plugin missing')
      const oldApp = join(home, 'electron', 'previous-app')
      const oldCopy = join(oldApp, 'node_modules', ...GIT.split('/'))
      mkdirSync(dirname(oldCopy), { recursive: true })
      writeFileSync(join(oldApp, 'package.json'), JSON.stringify({ dshElectron: { ecosystemPlugins: [GIT] } }))
      cpSync(realpathSync(plugin.rootPath), oldCopy, { recursive: true })
      const profileGit = join(dir, 'node_modules', ...GIT.split('/'))
      mkdirSync(dirname(profileGit), { recursive: true })
      symlinkSync(oldCopy, profileGit, 'junction')
      expect(hasLegacyDesktopLink(dir, plugin)).toBe(true)
      rmSync(oldApp, { recursive: true, force: true })
      expect(hasLegacyDesktopLink(dir, plugin)).toBe(true)
      operation.mockImplementation(async (_context, args) => {
        expect(args).toEqual(['add', `${GIT}@0.3.1`, '--force'])
        unlinkSync(profileGit)
        cpSync(realpathSync(plugin.rootPath), profileGit, { recursive: true })
        return packageResult
      })
      await prepareEcosystemProfile(appPath, home, manager)
      expect(operation).toHaveBeenCalledOnce()
      expect(lstatSync(profileGit).isSymbolicLink()).toBe(false)
      expect(readProfileManifest('dsh', dir).dependencies?.[GIT]).toBe('0.3.1')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('does not reinstall a package after the user uninstalls it', async () => {
    const { home, dir } = fixture()
    try {
      const template = PROFILE_TEMPLATES[WEB_PROFILE_NAME]
      if (template === undefined) throw new Error('web template missing')
      initProfile(dir, template.bundles)
      mkdirSync(join(home, 'electron'), { recursive: true })
      writeFileSync(join(home, 'electron', 'ecosystem-preinstalled'), 'done\n')
      await prepareEcosystemProfile(appPath, home, manager)
      expect(operation).not.toHaveBeenCalled()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})
