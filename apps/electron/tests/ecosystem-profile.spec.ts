import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  initProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { prepareEcosystemProfile, WEB_PROFILE_NAME } from '../src/ecosystem-profile.ts'
import { prepareHostProfileProjection, resolveHostProfileDir } from '../src/host-profile.ts'
import { discoverEcosystemPluginPackages, webProfileModuleLinkPath } from '../src/runtime-plugins.ts'

const appPath = fileURLToPath(new URL('..', import.meta.url))
const GIT = '@dsh-electron/dsh-plugin-git'
const THEME = '@dsh-electron/dsh-theme-studio'

describe('ecosystem web profile seed', () => {
  it('enables a new ecosystem dependency on first seed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-electron-seed-new-'))
    try {
      await prepareEcosystemProfile(appPath, home)
      const dir = resolveProfileDir(WEB_PROFILE_NAME, home)
      const manifest = readProfileManifest('dsh', dir)
      expect(manifest.dependencies?.[GIT]).toBe('0.2.3')
      expect(manifest.dsh?.profile?.bundles).toContain(GIT)
      expect(manifest.dependencies?.[THEME]).toBe('0.1.2')
      expect(manifest.dsh?.profile?.bundles).toContain(THEME)
      expect(existsSync(join(dir, 'node_modules', ...GIT.split('/'), 'package.json'))).toBe(true)
      expect(lstatSync(join(dir, 'node_modules', ...GIT.split('/'))).isSymbolicLink()).toBe(false)
      expect(readProfileManifest('dsh', join(dir, 'node_modules', ...GIT.split('/'))).version).toBe('0.2.3')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not change bundles when the dependency already exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-electron-seed-keep-'))
    try {
      const dir = resolveProfileDir(WEB_PROFILE_NAME, home)
      const template = PROFILE_TEMPLATES[WEB_PROFILE_NAME]
      if (template === undefined) throw new Error('web template missing')
      initProfile(dir, template.bundles)
      const before = readProfileManifest('dsh', dir)
      writeProfileManifest(dir, {
        ...before,
        dependencies: { ...before.dependencies, [GIT]: '0.2.3', [THEME]: '0.1.2' },
        dsh: { ...before.dsh, profile: { ...before.dsh?.profile, bundles: [...(before.dsh?.profile?.bundles ?? [])] } },
      })
      const bundlesBefore = readProfileManifest('dsh', dir).dsh?.profile?.bundles ?? []
      expect(bundlesBefore).not.toContain(GIT)
      await prepareEcosystemProfile(appPath, home)
      const after = readProfileManifest('dsh', dir)
      expect(after.dependencies?.[GIT]).toBe('0.2.3')
      expect(after.dsh?.profile?.bundles).toEqual(bundlesBefore)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('re-seeds and enables after uninstall removes the dependency', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-electron-seed-re-'))
    try {
      await prepareEcosystemProfile(appPath, home)
      const dir = resolveProfileDir(WEB_PROFILE_NAME, home)
      const installed = readProfileManifest('dsh', dir)
      const { [GIT]: _removed, ...dependencies } = installed.dependencies ?? {}
      writeProfileManifest(dir, {
        ...installed,
        dependencies,
        dsh: {
          ...installed.dsh,
          profile: {
            ...installed.dsh?.profile,
            bundles: (installed.dsh?.profile?.bundles ?? []).filter(name => name !== GIT),
          },
        },
      })
      mkdirSync(join(dir, 'node_modules'), { recursive: true })
      await prepareEcosystemProfile(appPath, home)
      const restored = readProfileManifest('dsh', dir)
      expect(restored.dependencies?.[GIT]).toBe('0.2.3')
      expect(restored.dsh?.profile?.bundles).toContain(GIT)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('waits for a profile package operation before seeding without ecosystem symlinks', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-electron-seed-locked-'))
    const dir = resolveProfileDir(WEB_PROFILE_NAME, home)
    const template = PROFILE_TEMPLATES[WEB_PROFILE_NAME]
    if (template === undefined) throw new Error('web template missing')
    initProfile(dir, template.bundles)
    let release!: () => void
    let acquired!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const ready = new Promise<void>((resolve) => { acquired = resolve })
    const holder = withFileLock(join(dir, 'package.json'), async () => {
      acquired()
      await held
    })
    let preparation: Promise<void> | undefined
    try {
      await ready
      preparation = prepareEcosystemProfile(appPath, home)
      expect(existsSync(webProfileModuleLinkPath(home, GIT))).toBe(false)
      const manifest = readProfileManifest('dsh', dir)
      await writeFileAtomic(join(dir, 'package.json'), JSON.stringify({
        ...manifest,
        dependencies: { ...manifest.dependencies, 'fixture-package': '1.0.0' },
      }, undefined, 2) + '\n', { mode: 0o600 })
      release()
      await holder
      await preparation
      const seeded = readProfileManifest('dsh', dir)
      expect(seeded.dependencies?.['fixture-package']).toBe('1.0.0')
      expect(seeded.dependencies?.[GIT]).toBe('0.2.3')
      expect(lstatSync(join(dir, 'node_modules', ...GIT.split('/'))).isSymbolicLink()).toBe(false)
      expect(existsSync(join(dir, 'node_modules', ...GIT.split('/'), 'package.json'))).toBe(true)
    } finally {
      release()
      await Promise.allSettled([holder, ...(preparation === undefined ? [] : [preparation])])
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps the shared profile package after host-profile materialization', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-electron-seed-projection-'))
    try {
      await prepareEcosystemProfile(appPath, home)
      const dir = resolveProfileDir(WEB_PROFILE_NAME, home)
      const profileGit = join(dir, 'node_modules', ...GIT.split('/'))
      writeFileSync(join(profileGit, 'marker.txt'), 'profile-owned')
      const before = readFileSync(join(profileGit, 'package.json'), 'utf8')
      const hostDir = prepareHostProfileProjection(appPath, home)
      const plugin = discoverEcosystemPluginPackages(appPath).find(item => item.name === GIT)
      expect(plugin).toBeDefined()
      expect(hostDir).toBe(resolveHostProfileDir(home))
      expect(readlinkSync(join(hostDir!, 'node_modules', ...GIT.split('/')))).toBe(plugin!.rootPath)
      expect(lstatSync(profileGit).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(profileGit, 'marker.txt'), 'utf8')).toBe('profile-owned')
      expect(readFileSync(join(profileGit, 'package.json'), 'utf8')).toBe(before)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
