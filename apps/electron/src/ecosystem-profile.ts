/**
 * Seed Desktop-preinstalled ecosystem plugins into the shared web profile.
 * A new dependency is enabled; an existing dependency keeps its bundle selection.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { discoverEcosystemPluginPackages } from './runtime-plugins.ts'

/** Profile name the supervised `dsh web` process loads. */
export const WEB_PROFILE_NAME = 'web'

/** Diagnostic prefix shared with the supervised CLI. */
const BIN_NAME = 'dsh'

interface ElectronAppManifest {
  dependencies?: Record<string, string>
}

/**
 * Ensure the web profile lists each Desktop ecosystem plugin as a pinned dependency.
 * A missing profile is initialized from the shipped web template. A name that is
 * not yet a dependency is pinned to the Desktop application version and appended
 * to `dsh.profile.bundles` (enabled). A name already in `dependencies` is left
 * unchanged, including a user Disable that removed it from `bundles`.
 * Uninstall drops the dependency; the next Desktop boot seeds it again and enables it.
 * @param appPath - Electron application root holding `dshElectron.ecosystemPlugins`.
 * @param harnessHome - Active `$DSH_HOME`.
 */
export function seedEcosystemProfile(appPath: string, harnessHome: string): void {
  const dir = resolveProfileDir(WEB_PROFILE_NAME, harnessHome)
  const template = PROFILE_TEMPLATES[WEB_PROFILE_NAME]
  if (template === undefined) {
    throw new Error(`ecosystem profile: shipped ${WEB_PROFILE_NAME} template is missing`)
  }
  if (!existsSync(join(dir, 'package.json'))) initProfile(dir, template.bundles)
  const manifest = readProfileManifest(BIN_NAME, dir)
  const appManifest = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as ElectronAppManifest
  const dependencies = { ...manifest.dependencies }
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  let changed = false
  for (const plugin of discoverEcosystemPluginPackages(appPath)) {
    if (Object.hasOwn(dependencies, plugin.name)) continue
    const pin = appManifest.dependencies?.[plugin.name]
    if (typeof pin !== 'string' || pin.length === 0) {
      throw new Error(`ecosystem profile: ${plugin.name} has no exact pin in ${join(appPath, 'package.json')}`)
    }
    dependencies[plugin.name] = pin
    if (!bundles.includes(plugin.name)) bundles.push(plugin.name)
    changed = true
  }
  if (!changed) return
  writeProfileManifest(dir, withProfileDependencies(manifest, dependencies, bundles))
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
