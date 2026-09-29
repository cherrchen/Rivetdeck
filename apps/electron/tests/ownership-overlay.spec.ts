import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import {
  composeEntries,
  createRuntimeResolution,
  loadProfileDirectory,
  PROFILE_PATCH_FILENAME,
  readProfilePatches,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
  type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { prepareEcosystemProfile, WEB_PROFILE_NAME } from '../src/ecosystem-profile.ts'
import { apply as applyCapabilitiesHost } from '../runtime/plugins/desktop-capabilities/src/index.ts'
import { prepareHostProfileProjection } from '../src/host-profile.ts'
import { resolveDshInstallAnchor } from '../src/runtime.ts'
import {
  ecosystemCanonicalIds,
  flattenEntries,
  generateOwnershipOverlay,
  loadPreElectronPatchLayers,
  ownershipSuppressions,
  staticOverlayInsertNames,
} from '../src/ownership-overlay.ts'
import { prepareHostRuntimeOverlay } from '../src/runtime-overlay.ts'
import {
  discoverEcosystemPluginPackages,
  discoverRuntimePluginDirectories,
  profileModuleLinkPath,
  webProfileModuleLinkPath,
} from '../src/runtime-plugins.ts'

const OVERLAY_INSERT_NAMES = [
  '@dsh-electron/dsh-electron-network-subprocess',
  '@deepseek-ai/dsh-host-directory-picker-browse',
  '@dsh-electron/dsh-electron-desktop-capabilities',
] as const

const appPath = fileURLToPath(new URL('..', import.meta.url))
const GIT = '@dsh-electron/dsh-plugin-git'
const THEME = '@dsh-electron/dsh-theme-studio'

describe('Desktop overlay insert names', () => {
  it('inserts the three required Loader packages and omits ecosystem bundles', () => {
    const yaml = readFileSync(join(appPath, 'runtime', 'host.patch.yml'), 'utf8')
    const names = staticOverlayInsertNames(yaml)
    expect(names).toEqual([...OVERLAY_INSERT_NAMES])
    expect(names).not.toContain(GIT)
    expect(names).not.toContain(THEME)
  })
})

describe('ownership-aware Electron overlay', () => {
  it('writes an overlay when the web profile is missing', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'dsh-electron-overlay-missing-'))
    const home = mkdtempSync(join(tmpdir(), 'dsh-electron-home-missing-'))
    try {
      const overlay = await prepareHostRuntimeOverlay(appPath, userData, home)
      const body = readFileSync(overlay.patchPath, 'utf8')
      expect(body).toContain('id: desktop-capabilities')
      expect(body).not.toContain(GIT)
    } finally {
      rmSync(userData, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('disables profile and home ecosystem duplicates while keeping the bundle row', async () => {
    const home = await seededHome()
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
      prepareHostProfileProjection(appPath, home)
      const composed = composeWithOverlay(appPath, home)
      const theme = named(composed, THEME)
      expect(theme.filter(row => row.id === 'user-theme-studio' || row.id === 'home-theme-studio')
        .every(row => row.disabled === true)).toBe(true)
      expect(active(theme)).toEqual(['theme-studio'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('refreshes ownership after a new same-name row arrives during Host HMR', async () => {
    const home = await seededHome()
    const ctx = new Context()
    try {
      prepareHostProfileProjection(appPath, home)
      const dir = resolveProfileDir(WEB_PROFILE_NAME, home)
      const initial: unknown = load(generateOwnershipOverlay(appPath, home))
      if (!Array.isArray(initial)) throw new Error('initial overlay is not a patch list')
      const profile: ProfileContext = {
        name: WEB_PROFILE_NAME, dir, patchPath: join(dir, PROFILE_PATCH_FILENAME),
        installAnchor: resolveDshInstallAnchor(appPath), cwd: appPath, home,
        startedBundles: [], overlays: initial as PatchOptions[], telemetryDisabledEnv: undefined,
      }
      ctx.provide('profileContext', profile)
      applyCapabilitiesHost(ctx)
      writeFileSync(profile.patchPath, `
- insert:
    - id: later-theme
      name: '${THEME}'
    - id: later-capabilities
      name: '@dsh-electron/dsh-electron-desktop-capabilities'
`)
      prepareHostProfileProjection(appPath, home)
      const composed = composeEntries([readProfilePatches('dsh', profile)])
      expect(active(named(composed, THEME))).toEqual(['theme-studio'])
      expect(active(named(composed, '@dsh-electron/dsh-electron-desktop-capabilities'))).toEqual(['desktop-capabilities'])
      expect(named(composed, THEME).find(row => row.id === 'later-theme')?.disabled).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps the enabled Git bundle row and disables extra home and user copies', async () => {
    const home = await seededHome()
    try {
      prepareHostProfileProjection(appPath, home)
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
      prepareHostProfileProjection(appPath, home)
      const composed = composeWithOverlay(appPath, home)
      const gitRows = named(composed, GIT)
      expect(active(gitRows)).toEqual(['dsh-plugin-git'])
      expect(gitRows.find(row => row.id === 'user-git-dup')?.disabled).toBe(true)
      expect(gitRows.find(row => row.id === 'home-git-dup')?.disabled).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('leaves no active ecosystem row when bundles are disabled', async () => {
    const home = await seededHome()
    try {
      const dir = resolveProfileDir(WEB_PROFILE_NAME, home)
      const manifest = readProfileManifest('dsh', dir)
      writeProfileManifest(dir, {
        ...manifest,
        dsh: {
          ...manifest.dsh,
          profile: {
            ...manifest.dsh?.profile,
            bundles: (manifest.dsh?.profile?.bundles ?? []).filter(name => name !== GIT && name !== THEME),
          },
        },
      })
      writeFileSync(join(home, PROFILE_PATCH_FILENAME), `
- insert:
    - id: home-git-dup
      name: '${GIT}'
    - id: home-theme-dup
      name: '${THEME}'
`)
      prepareHostProfileProjection(appPath, home)
      const composed = composeWithOverlay(appPath, home)
      expect(active(named(composed, GIT))).toEqual([])
      expect(active(named(composed, THEME))).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps an applied layer canonical id that differs from a Desktop package guess', () => {
    const composed: EntryOptions[] = [
      { id: 'git-next', name: GIT },
      { id: 'foreign-git', name: GIT },
    ]
    const suppressions = ownershipSuppressions(
      composed,
      new Set(),
      discoverEcosystemPluginPackages(appPath),
      new Set([GIT]),
      [{
        packageName: GIT,
        packageDir: '/tmp/unused',
        patchPaths: [],
        patches: [{ insert: [{ id: 'git-next', name: GIT }] }],
      }],
    )
    expect(suppressions).toEqual([{ id: 'foreign-git', disabled: true }])
  })
})

describe('concurrent CLI and Desktop resolution ownership', () => {
  it('resolves profile and Electron package directories without rewriting shared node_modules', async () => {
    const home = await seededHome()
    try {
      const webDir = resolveProfileDir(WEB_PROFILE_NAME, home)
      const profileGit = join(webDir, 'node_modules', ...GIT.split('/'))
      writeFileSync(join(profileGit, 'package.json'), JSON.stringify({
        name: GIT,
        version: '0.3.1',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      writeFileSync(join(profileGit, 'cordis.patch.yml'), `
- insert:
    - id: dsh-plugin-git
      name: '${GIT}'
`)
      const hostDir = prepareHostProfileProjection(appPath, home)
      expect(hostDir).toBeDefined()
      const installAnchor = resolveDshInstallAnchor(appPath)
      const electronProfile = loadProfileDirectory('dsh', hostDir!, installAnchor)
      const electronResolution = await createRuntimeResolution({ installAnchor, profile: electronProfile, home })
      const plugin = discoverEcosystemPluginPackages(appPath).find(item => item.name === GIT)
      expect(plugin).toBeDefined()
      expect(JSON.parse(readFileSync(join(profileGit, 'package.json'), 'utf8')).version).toBe('0.3.1')
      expect(lstatSync(profileGit).isSymbolicLink()).toBe(false)
      expect(readlinkSync(join(hostDir!, 'node_modules', ...GIT.split('/')))).toBe(plugin!.rootPath)
      expect(electronProfile.layers.find(layer => layer.packageName === GIT)?.packageDir).toBe(plugin!.rootPath)
      expect(electronResolution.localPackageNames).toContain(GIT)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps required runtime plugins Desktop-owned against a fake profile package', async () => {
    const home = await seededHome()
    try {
      const runtime = discoverRuntimePluginDirectories(appPath)[0]
      if (runtime === undefined) throw new Error('runtime plugin missing')
      const { ensureRuntimePluginsLinked } = await import('../src/runtime-plugins.ts')
      const { lstatSync, unlinkSync } = await import('node:fs')
      const fake = webProfileModuleLinkPath(home, runtime.name)
      if (existsSync(fake) && lstatSync(fake).isSymbolicLink()) unlinkSync(fake)
      mkdirSync(fake, { recursive: true })
      writeFileSync(join(fake, 'package.json'), JSON.stringify({ name: runtime.name, version: '9.9.9' }))
      ensureRuntimePluginsLinked(appPath, home)
      expect(readlinkSync(webProfileModuleLinkPath(home, runtime.name))).toBe(runtime.rootPath)
      expect(readlinkSync(profileModuleLinkPath(home, runtime.name))).toBe(runtime.rootPath)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

async function seededHome(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-electron-overlay-'))
  await prepareEcosystemProfile(appPath, home)
  return home
}

function composeWithOverlay(applicationRoot: string, harnessHome: string): EntryOptions[] {
  const { layers } = loadPreElectronPatchLayers(applicationRoot, harnessHome)
  const overlay = load(generateOwnershipOverlay(applicationRoot, harnessHome))
  if (!Array.isArray(overlay)) throw new Error('overlay is not a patch list')
  return composeEntries([...layers, overlay as PatchOptions[]])
}

function named(rows: readonly EntryOptions[], name: string): EntryOptions[] {
  return flattenEntries(rows).filter(row => row.name === name)
}

function active(rows: readonly EntryOptions[]): string[] {
  return rows.filter(row => row.disabled !== true).map(row => String(row.id))
}
