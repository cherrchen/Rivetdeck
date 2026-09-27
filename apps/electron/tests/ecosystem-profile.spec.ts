import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  initProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { seedEcosystemProfile, WEB_PROFILE_NAME } from '../src/ecosystem-profile.ts'

const appPath = fileURLToPath(new URL('..', import.meta.url))
const GIT = '@dsh-electron/dsh-plugin-git'
const THEME = '@dsh-electron/dsh-theme-studio'

describe('ecosystem web profile seed', () => {
  it('enables a new ecosystem dependency on first seed', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-electron-seed-new-'))
    try {
      seedEcosystemProfile(appPath, home)
      const manifest = readProfileManifest('dsh', resolveProfileDir(WEB_PROFILE_NAME, home))
      expect(manifest.dependencies?.[GIT]).toBe('0.2.3')
      expect(manifest.dsh?.profile?.bundles).toContain(GIT)
      expect(manifest.dependencies?.[THEME]).toBe('0.1.2')
      expect(manifest.dsh?.profile?.bundles).toContain(THEME)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not change bundles when the dependency already exists', () => {
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
      seedEcosystemProfile(appPath, home)
      const after = readProfileManifest('dsh', dir)
      expect(after.dependencies?.[GIT]).toBe('0.2.3')
      expect(after.dsh?.profile?.bundles).toEqual(bundlesBefore)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('re-seeds and enables after uninstall removes the dependency', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-electron-seed-re-'))
    try {
      seedEcosystemProfile(appPath, home)
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
      seedEcosystemProfile(appPath, home)
      const restored = readProfileManifest('dsh', dir)
      expect(restored.dependencies?.[GIT]).toBe('0.2.3')
      expect(restored.dsh?.profile?.bundles).toContain(GIT)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
