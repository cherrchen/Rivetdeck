/**
 * Seed Desktop-preinstalled ecosystem plugins into the shared web profile.
 * A new dependency is enabled; an existing dependency keeps its bundle selection.
 * Profile package persistence stays on disk; Desktop runtime ownership uses the
 * process-private host-profile projection instead of shared profile symlinks.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  initProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import {
  discoverEcosystemPluginPackages,
  ensureRuntimePluginsLinked,
  type RuntimePluginManifest,
} from './runtime-plugins.ts'

/** Profile name the supervised Host and CLI share for persistence. */
export const WEB_PROFILE_NAME = 'web'

/** Diagnostic prefix shared with the supervised CLI. */
const BIN_NAME = 'dsh'

interface ElectronAppManifest {
  dependencies?: Record<string, string>
}

/**
 * Link required runtime plugins and seed ecosystem dependencies under the same
 * package lock used by CLI and Plugin Manager operations.
 * @param appPath - Electron application root holding `dshElectron.ecosystemPlugins`.
 * @param harnessHome - Active `$DSH_HOME`.
 */
export async function prepareEcosystemProfile(appPath: string, harnessHome: string): Promise<void> {
  const dir = resolveProfileDir(WEB_PROFILE_NAME, harnessHome)
  // The profile can be absent on first launch; the lock's parent must exist.
  mkdirSync(dir, { recursive: true })
  await withFileLock(join(dir, 'package.json'), async () => {
    ensureRuntimePluginsLinked(appPath, harnessHome)
    await seedEcosystemProfile(appPath, dir)
  })
}

/**
 * Ensure the web profile lists each Desktop ecosystem plugin as a pinned dependency
 * and owns a real installed package directory (not a Desktop symlink).
 * A missing profile is initialized from the shipped web template. A name that is
 * not yet a dependency is pinned to the Desktop application version and appended
 * to `dsh.profile.bundles` (enabled). A name already in `dependencies` is left
 * unchanged, including a user Disable that removed it from `bundles`.
 * Uninstall drops the dependency; the next Desktop boot seeds it again and enables it.
 * @param appPath - Electron application root holding `dshElectron.ecosystemPlugins`.
 * @param dir - Locked web profile directory.
 */
async function seedEcosystemProfile(appPath: string, dir: string): Promise<void> {
  const template = PROFILE_TEMPLATES[WEB_PROFILE_NAME]
  if (template === undefined) {
    throw new Error(`ecosystem profile: shipped ${WEB_PROFILE_NAME} template is missing`)
  }
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const initial: ProfileManifest & { private: boolean } = {
      name: `dsh-profile-${WEB_PROFILE_NAME}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...template.bundles] } },
    }
    await writeFileAtomic(manifestPath, JSON.stringify(initial, undefined, 2) + '\n', { mode: 0o600 })
  }
  initProfile(dir, template.bundles)
  const manifest = readProfileManifest(BIN_NAME, dir)
  const appManifest = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as ElectronAppManifest
  const dependencies = { ...manifest.dependencies }
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  let changed = false
  const seeded: RuntimePluginManifest[] = []
  for (const plugin of discoverEcosystemPluginPackages(appPath)) {
    if (!Object.hasOwn(dependencies, plugin.name)) {
      const pin = appManifest.dependencies?.[plugin.name]
      if (typeof pin !== 'string' || pin.length === 0) {
        throw new Error(`ecosystem profile: ${plugin.name} has no exact pin in ${join(appPath, 'package.json')}`)
      }
      dependencies[plugin.name] = pin
      if (!bundles.includes(plugin.name)) bundles.push(plugin.name)
      changed = true
    }
    seeded.push(plugin)
  }
  if (changed) {
    await writeFileAtomic(
      manifestPath,
      JSON.stringify(withProfileDependencies(manifest, dependencies, bundles), undefined, 2) + '\n',
      { mode: 0o600 },
    )
  }
  for (const plugin of seeded) {
    ensureProfileOwnedPackage(dir, plugin)
  }
}

/**
 * Ensure the shared profile holds a real package directory for one ecosystem plugin.
 * Copies the Desktop bundled artifact when the profile has no installed package yet.
 * Never replaces an existing profile-owned install with a Desktop symlink.
 * @param profileDir - Shared web profile directory.
 * @param plugin - Desktop-bundled ecosystem plugin.
 */
export function ensureProfileOwnedPackage(profileDir: string, plugin: RuntimePluginManifest): void {
  const dest = join(profileDir, 'node_modules', ...plugin.name.split('/'))
  if (existsSync(join(dest, 'package.json'))) return
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(realpathSync(plugin.rootPath), dest, { recursive: true })
}

/**
 * Write dependency pins and the active bundle list without dropping other manifest fields.
 * @param manifest - Current profile manifest.
 * @param dependencies - Next `dependencies` map.
 * @param bundles - Next `dsh.profile.bundles` list.
 * @returns Manifest ready to persist.
 */
function withProfileDependencies(
  manifest: ProfileManifest,
  dependencies: Record<string, string>,
  bundles: readonly string[],
): ProfileManifest {
  return {
    ...manifest,
    dependencies,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: [...bundles],
      },
    },
  }
}
