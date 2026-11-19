/** Exact-version compatibility waivers that keep bundled ecosystem plugins loadable on the bundled runtime. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  evaluatePluginCompatibility,
  getDshRuntimeVersion,
  readProfileVersionExemptions,
  setProfileVersionExemption,
} from '@deepseek-ai/dsh-app-boot'
import { discoverEcosystemPluginPackages } from './runtime-plugins.ts'

/** Desktop manifest fields that declare bundled npm plugins and their temporary waivers. */
interface ElectronCompatibilityManifest {
  dshElectron?: {
    /** Exact `package@version` keys granted an exemption for the bundled runtime. */
    compatibilityWaivers?: string[]
  }
}

/** One waived plugin release, split into its npm package name and exact version. */
export interface EcosystemCompatibilityWaiver {
  /** npm package name. */
  name: string
  /** Exact published version. */
  version: string
  /** Exact `name@version` key stored in the profile compatibility file. */
  key: string
}

/**
 * Read the compatibility waivers the Desktop manifest declares for bundled ecosystem plugins.
 * A waiver keeps one exact published release loadable when it predates the bundled DSH runtime;
 * every entry must name an exact `package@version` because the profile exemption is version-exact.
 * @param appPath - Electron application root containing package.json.
 * @returns Declared waivers in manifest order.
 * @throws When a waiver is not an exact `package@version` pair.
 */
export function readCompatibilityWaivers(appPath: string): EcosystemCompatibilityWaiver[] {
  const manifest = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as ElectronCompatibilityManifest
  const declared = manifest.dshElectron?.compatibilityWaivers ?? []
  return declared.map((key) => {
    const separator = key.lastIndexOf('@')
    if (separator <= 0 || key.slice(separator + 1).trim() === '') {
      throw new Error(`desktop compatibility waiver ${JSON.stringify(key)} is not an exact package@version pair`)
    }
    return { name: key.slice(0, separator), version: key.slice(separator + 1), key }
  })
}

/**
 * Grant each declared waiver to the profile before its bundles load.
 * Only releases the bundled runtime cannot satisfy are granted; a waiver whose release already
 * declares the runtime is left alone, and a waiver naming an absent or different bundled release
 * fails instead of silently authorizing nothing.
 * @param appPath - Electron application root holding the bundled ecosystem packages.
 * @param profileDir - Shared profile directory receiving `compatibility.json`.
 * @param waivers - Waivers read from the Desktop manifest.
 * @returns Granted `package@version` keys, in manifest order.
 * @throws When a waiver names no bundled ecosystem plugin or a different bundled version.
 */
export async function grantCompatibilityWaivers(
  appPath: string,
  profileDir: string,
  waivers: readonly EcosystemCompatibilityWaiver[],
): Promise<string[]> {
  if (waivers.length === 0) return []
  const ecosystem = discoverEcosystemPluginPackages(appPath)
  const runtimeVersion = getDshRuntimeVersion()
  const exemptions = readProfileVersionExemptions(profileDir)
  const granted: string[] = []
  for (const waiver of waivers) {
    const plugin = ecosystem.find(candidate => candidate.name === waiver.name)
    if (plugin === undefined) {
      throw new Error(`desktop compatibility waiver ${waiver.key} names no bundled ecosystem plugin`)
    }
    if (plugin.version !== waiver.version) {
      throw new Error(`desktop compatibility waiver ${waiver.key} names ${waiver.version} but the bundled release is ${plugin.version}`)
    }
    const manifest = JSON.parse(readFileSync(join(plugin.rootPath, 'package.json'), 'utf8')) as object
    if (evaluatePluginCompatibility(manifest, exemptions) === undefined) continue
    if (exemptions[waiver.key]?.includes(runtimeVersion) === true) continue
    await setProfileVersionExemption(profileDir, waiver.key, runtimeVersion, true, true)
    granted.push(waiver.key)
  }
  return granted
}
