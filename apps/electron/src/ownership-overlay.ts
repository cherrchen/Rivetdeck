/**
 * Build the Electron Host overlay so Desktop-owned plugins keep one canonical row.
 * Required runtime names are fully suppressed in the pre-Electron tree, then the
 * static overlay inserts their Desktop copies. Ecosystem bundle rows stay when
 * enabled; extra same-name rows from profile or home patches are disabled.
 * Physical package selection is owned by the process-private host-profile
 * projection; this overlay only dedupes Cordis config rows.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bundlePatchPaths,
  composeEntries,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfileDirectory,
  PROFILE_PATCH_FILENAME,
  readProfileManifest,
  resolveProfileDir,
  type ProfileLayer,
} from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { dump, load } from 'js-yaml'
import { WEB_PROFILE_NAME } from './ecosystem-profile.ts'
import { resolveHostProfileDir, prepareHostProfileProjection } from './host-profile.ts'
import { resolveDshInstallAnchor } from './runtime.ts'
import {
  discoverEcosystemPluginPackages,
  type RuntimePluginManifest,
} from './runtime-plugins.ts'

/** Diagnostic prefix shared with the supervised CLI. */
const BIN_NAME = 'dsh'

/** Relative path of the packaged Desktop Host composition. */
export const HOST_PATCH_RELATIVE = join('runtime', 'host.patch.yml')

interface BundleDeclaringManifest {
  dsh?: { bundle?: { patch: string | string[] } }
}

/**
 * Patch lists applied before the Electron `--patch`, in `readProfilePatches` order
 * without command-line overlays or the telemetry switch: bundle layers, the web
 * profile patch, then `$DSH_HOME/cordis.patch.yml`. A missing profile or home
 * patch is an empty layer.
 * Desktop Host generation prefers the process-private projection so ecosystem
 * layers match the packages the Host will import.
 * @param appPath - Electron application root.
 * @param harnessHome - Active `$DSH_HOME`.
 * @returns Ordered patch layers and the profile's selected bundle names.
 */
export function loadPreElectronPatchLayers(
  appPath: string,
  harnessHome: string,
): { layers: PatchOptions[][]; bundles: readonly string[]; profileLayers: readonly ProfileLayer[] } {
  const webDir = resolveProfileDir(WEB_PROFILE_NAME, harnessHome)
  const homePatches = loadOptionalPatches(BIN_NAME, join(harnessHome, PROFILE_PATCH_FILENAME)) ?? []
  if (!existsSync(join(webDir, 'package.json'))) {
    return { layers: [[], homePatches], bundles: [], profileLayers: [] }
  }
  const installAnchor = resolveDshInstallAnchor(appPath)
  const existingHost = resolveHostProfileDir(harnessHome)
  const hostDir = existsSync(join(existingHost, 'package.json'))
    ? existingHost
    : prepareHostProfileProjection(appPath, harnessHome)
  const profileDir = hostDir ?? webDir
  const profile = loadProfileDirectory(BIN_NAME, profileDir, installAnchor)
  const manifest = readProfileManifest(BIN_NAME, webDir)
  return {
    layers: [
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
      homePatches,
    ],
    bundles: manifest.dsh?.profile?.bundles ?? [],
    profileLayers: profile.layers,
  }
}

/**
 * Collect overlay insert package names from a Host patch document.
 * @param yaml - `host.patch.yml` text.
 * @returns Package names the overlay inserts, in file order.
 */
export function staticOverlayInsertNames(yaml: string): string[] {
  const names: string[] = []
  const parsed: unknown = load(yaml)
  if (!Array.isArray(parsed)) return names
  for (const item of parsed) {
    if (!isRecord(item) || !Array.isArray(item.insert)) continue
    for (const row of item.insert) {
      if (isRecord(row) && typeof row.name === 'string') names.push(row.name)
    }
  }
  return names
}

/**
 * Disable patches for foreign Desktop-owned rows, followed by the static overlay text.
 * Missing ids are never emitted; include already warns when a disable targets nothing.
 * @param appPath - Electron application root.
 * @param harnessHome - Active `$DSH_HOME`.
 * @returns Overlay YAML passed to the supervised Host.
 */
export function generateOwnershipOverlay(appPath: string, harnessHome: string): string {
  const staticYaml = readFileSync(join(appPath, HOST_PATCH_RELATIVE), 'utf8')
  const requiredNames = new Set(staticOverlayInsertNames(staticYaml))
  const { layers, bundles, profileLayers } = loadPreElectronPatchLayers(appPath, harnessHome)
  const composed = composeEntries(layers)
  const suppressions = ownershipSuppressions(
    composed,
    requiredNames,
    discoverEcosystemPluginPackages(appPath),
    new Set(bundles),
    profileLayers,
  )
  if (suppressions.length === 0) return staticYaml
  return `${dump(suppressions, { lineWidth: -1, noRefs: true }).trimEnd()}\n${staticYaml}`
}

/**
 * Build `{ id, disabled: true }` patches for pre-Electron rows that Desktop must not leave active.
 * Required runtime names are all suppressed. An enabled ecosystem package keeps the ids its
 * applied bundle layer inserts and suppresses every other same-name row. A disabled ecosystem
 * package suppresses every remaining copy; the overlay never inserts those packages.
 * @param composed - Pre-Electron composed entries.
 * @param requiredNames - Package names the static overlay inserts.
 * @param ecosystem - Desktop-owned ecosystem plugins.
 * @param enabledBundles - Names currently listed in `dsh.profile.bundles`.
 * @param profileLayers - Bundle layers actually applied for this Host composition.
 * @returns Disable patches targeting existing row ids only.
 */
export function ownershipSuppressions(
  composed: readonly EntryOptions[],
  requiredNames: ReadonlySet<string>,
  ecosystem: readonly RuntimePluginManifest[],
  enabledBundles: ReadonlySet<string>,
  profileLayers: readonly ProfileLayer[] = [],
): PatchOptions[] {
  const layerByName = new Map(profileLayers.map(layer => [layer.packageName, layer]))
  const canonicalByName = new Map<string, ReadonlySet<string>>()
  for (const plugin of ecosystem) {
    const layer = layerByName.get(plugin.name)
    canonicalByName.set(
      plugin.name,
      layer !== undefined ? canonicalIdsFromPatches(layer.patches) : ecosystemCanonicalIds(plugin),
    )
  }
  const suppressions: PatchOptions[] = []
  const seen = new Set<string>()
  for (const entry of flattenEntries(composed)) {
    if (typeof entry.id !== 'string' || typeof entry.name !== 'string') continue
    if (seen.has(entry.id)) continue
    if (requiredNames.has(entry.name)) {
      seen.add(entry.id)
      suppressions.push({ id: entry.id, disabled: true })
      continue
    }
    const canonical = canonicalByName.get(entry.name)
    if (canonical === undefined) continue
    if (enabledBundles.has(entry.name) && canonical.has(entry.id)) continue
    seen.add(entry.id)
    suppressions.push({ id: entry.id, disabled: true })
  }
  return suppressions
}

/**
 * Row ids a patch list inserts.
 * @param patches - Bundle or user patches.
 * @returns Inserted entry ids.
 */
export function canonicalIdsFromPatches(patches: readonly PatchOptions[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of flattenEntries(composeEntries([[...patches].filter(patch => patch.insert !== undefined)]))) {
    if (typeof entry.id === 'string') ids.add(entry.id)
  }
  return ids
}

/**
 * Ids the ecosystem package's own bundle patch inserts.
 * @param plugin - Installed ecosystem plugin.
 * @returns Row ids from `dsh.bundle.patch` insert lists.
 */
export function ecosystemCanonicalIds(plugin: RuntimePluginManifest): Set<string> {
  const manifest = JSON.parse(readFileSync(join(plugin.rootPath, 'package.json'), 'utf8')) as BundleDeclaringManifest
  const bundle = manifest.dsh?.bundle
  if (bundle === undefined) return new Set()
  const patches = bundlePatchPaths(plugin.rootPath, bundle)
    .flatMap(file => loadOverlayPatches(BIN_NAME, file))
    .filter(patch => patch.insert !== undefined)
  return canonicalIdsFromPatches(patches)
}

/**
 * Walk composed entries including group children.
 * @param rows - Top-level composed entries.
 * @returns Depth-first flattened rows.
 */
export function flattenEntries(rows: readonly EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [
    row,
    ...(row.group && Array.isArray(row.config) ? flattenEntries(row.config as EntryOptions[]) : []),
  ])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
