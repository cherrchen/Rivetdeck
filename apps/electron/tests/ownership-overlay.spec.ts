import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import {
  composeEntries,
  PROFILE_PATCH_FILENAME,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { seedEcosystemProfile, WEB_PROFILE_NAME } from '../src/ecosystem-profile.ts'
import {
  ecosystemCanonicalIds,
  flattenEntries,
  generateOwnershipOverlay,
  loadPreElectronPatchLayers,
  staticOverlayInsertNames,
} from '../src/ownership-overlay.ts'
import { prepareHostRuntimeOverlay } from '../src/runtime-overlay.ts'
import {
  discoverEcosystemPluginPackages,
  ensureRuntimePluginsLinked,
} from '../src/runtime-plugins.ts'

const OVERLAY_INSERT_NAMES = [
  '@dsh-electron/dsh-electron-network-subprocess',
  '@deepseek-ai/dsh-host-directory-picker-browse',
  '@dsh-electron/dsh-electron-desktop-capabilities',
  '@dsh-electron/dsh-theme-studio',
] as const

const appPath = fileURLToPath(new URL('..', import.meta.url))
const GIT = '@dsh-electron/dsh-plugin-git'
const THEME = '@dsh-electron/dsh-theme-studio'

describe('Desktop overlay insert names', () => {
  it('inserts the four Loader packages and omits Git', () => {
    const yaml = readFileSync(join(appPath, 'runtime', 'host.patch.yml'), 'utf8')
    const names = staticOverlayInsertNames(yaml)
    expect(names).toEqual([...OVERLAY_INSERT_NAMES])
    expect(names).not.toContain(GIT)
    expect(yaml).not.toContain('desktop-git')
    expect(yaml).not.toContain('desktop-directory-picker')
    expect(yaml).not.toContain('desktop-ui-brand')
    expect(yaml).not.toContain('desktop-ui-network-settings')
    expect(yaml).not.toContain('desktop-ui-plugins')
  })
})

describe('ownership-aware Electron overlay', () => {
  it('writes an overlay when the web profile is missing', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'dsh-electron-overlay-missing-'))
    const home = mkdtempSync(join(tmpdir(), 'dsh-electron-home-missing-'))
    try {
      const overlay = await prepareHostRuntimeOverlay(appPath, userData, home)
      const body = readFileSync(overlay.patchPath, 'utf8')
      expect(body).toContain("name: '@dsh-electron/dsh-theme-studio'")
      expect(body).toContain('id: desktop-capabilities')
      expect(body).not.toContain('desktop-ui-plugins')
      expect(body).not.toContain('desktop-git')
      expect(body).not.toContain(GIT)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('disables profile and home required duplicates and still inserts the canonical overlay row', () => {
    const home = seededHome()
    try {
      writeFileSync(join(resolveProfileDir(WEB_PROFILE_NAME, home), PROFILE_PATCH_FILENAME), `
- insert:
    - id: user-theme-studio
      name: '${THEME}'
`)
      writeFileSync(join(home, PROFILE_PATCH_FILENAME), `
- insert:
    - id: home-theme-studio
      name: '${THEME}'
`)
      const composed = composeWithOverlay(appPath, home)
      const theme = named(composed, THEME)
      expect(theme.filter(row => row.id === 'user-theme-studio' || row.id === 'home-theme-studio')
        .every(row => row.disabled === true)).toBe(true)
      expect(active(theme)).toEqual(['theme-studio'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps the enabled Git bundle row and disables extra home and user copies', () => {
    const home = seededHome()
    try {
      const git = discoverEcosystemPluginPackages(appPath)[0]
      if (git === undefined) throw new Error('git ecosystem plugin missing')
      expect([...ecosystemCanonicalIds(git)]).toEqual(['dsh-plugin-git'])
      writeFileSync(join(resolveProfileDir(WEB_PROFILE_NAME, home), PROFILE_PATCH_FILENAME), `
- insert:
    - id: user-git-dup
      name: '${GIT}'
`)
      writeFileSync(join(home, PROFILE_PATCH_FILENAME), `
- insert:
    - id: home-git-dup
      name: '${GIT}'
`)
      const overlay = generateOwnershipOverlay(appPath, home)
      expect(overlay).not.toContain('desktop-git')
      const composed = composeWithOverlay(appPath, home)
      const gitRows = named(composed, GIT)
      expect(active(gitRows)).toEqual(['dsh-plugin-git'])
      expect(gitRows.find(row => row.id === 'user-git-dup')?.disabled).toBe(true)
      expect(gitRows.find(row => row.id === 'home-git-dup')?.disabled).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('leaves no active Git row when the ecosystem bundle is disabled', () => {
    const home = seededHome()
    try {
      const dir = resolveProfileDir(WEB_PROFILE_NAME, home)
      const manifest = readProfileManifest('dsh', dir)
      writeProfileManifest(dir, {
        ...manifest,
        dsh: {
          ...manifest.dsh,
          profile: {
            ...manifest.dsh?.profile,
            bundles: (manifest.dsh?.profile?.bundles ?? []).filter(name => name !== GIT),
          },
        },
      })
      writeFileSync(join(home, PROFILE_PATCH_FILENAME), `
- insert:
    - id: home-git-dup
      name: '${GIT}'
`)
      const overlay = generateOwnershipOverlay(appPath, home)
      expect(overlay).not.toContain('desktop-git')
      const composed = composeWithOverlay(appPath, home)
      expect(active(named(composed, GIT))).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

function seededHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-electron-overlay-'))
  seedEcosystemProfile(appPath, home)
  ensureRuntimePluginsLinked(appPath, home)
  return home
}

function composeWithOverlay(applicationRoot: string, harnessHome: string): EntryOptions[] {
  const { layers } = loadPreElectronPatchLayers(applicationRoot, harnessHome)
  const overlay = load(generateOwnershipOverlay(applicationRoot, harnessHome))
  if (!Array.isArray(overlay)) throw new Error('generated overlay is not a patch list')
  return composeEntries([...layers, overlay as PatchOptions[]])
}

function named(entries: readonly EntryOptions[], packageName: string): EntryOptions[] {
  return flattenEntries(entries).filter(entry => entry.name === packageName)
}

function active(entries: readonly EntryOptions[]): string[] {
  return entries.filter(entry => entry.disabled !== true).map(entry => entry.id).filter((id): id is string => typeof id === 'string')
}
