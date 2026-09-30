/**
 * Process-private Host profile projection for Desktop ecosystem runtime ownership.
 * Persistence stays on the shared web profile; only this Host process resolves
 * ecosystem packages through Electron-bundled copies through `$DSH_HOME/electron/host-profile`.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  PROFILE_PATCH_FILENAME,
  PROFILE_COMPATIBILITY_FILENAME,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { WEB_PROFILE_NAME } from './ecosystem-profile.ts'
import {
  discoverEcosystemPluginPackages,
  ensureSymlink,
  type RuntimePluginManifest,
} from './runtime-plugins.ts'

/** Directory under `$DSH_HOME/electron` holding the Host resolution projection. */
export const HOST_PROFILE_RELATIVE = join('electron', 'host-profile')

/** Empty Cordis root the Loader anchors at the private profile directory. */
export const HOST_PROFILE_ROOT_FILENAME = 'cordis.yml'

/** Empty root entry list matching the supervised web profile root. */
export const HOST_PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/**
 * Absolute path of the process-private Host profile projection.
 * Lives under `$DSH_HOME/electron`, never under `profiles/`, so CLI `dsh web`
 * does not load it.
 * @param harnessHome - Active `$DSH_HOME`.
 * @returns Private profile directory used only by the supervised Host.
 */
export function resolveHostProfileDir(harnessHome: string): string {
  return join(harnessHome, HOST_PROFILE_RELATIVE)
}

/**
 * Materialize a Host-only profile directory whose ecosystem packages resolve to
 * Electron bundles while every other package forwards to the shared web profile.
 * A removed ecosystem dependency is selected only in this private projection;
 * an installed but disabled dependency remains disabled.
 * Shared `$DSH_HOME/profiles/web` is never rewritten for ecosystem ownership.
 * @param appPath - Electron application root.
 * @param harnessHome - Active `$DSH_HOME`.
 * @returns Absolute private profile directory, or `undefined` when the shared web profile is absent.
 */
export function prepareHostProfileProjection(
  appPath: string,
  harnessHome: string,
): string | undefined {
  const webDir = resolveProfileDir(WEB_PROFILE_NAME, harnessHome)
  if (!existsSync(join(webDir, 'package.json'))) return undefined
  const hostDir = resolveHostProfileDir(harnessHome)
  mkdirSync(hostDir, { recursive: true })
  const ecosystem = discoverEcosystemPluginPackages(appPath)
  syncProfileFile(join(webDir, 'package.json'), join(hostDir, 'package.json'))
  const manifest = readProfileManifest('dsh', webDir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const desktopOnly = ecosystem.filter(plugin => !Object.hasOwn(manifest.dependencies ?? {}, plugin.name)
    && !bundles.includes(plugin.name))
  if (desktopOnly.length > 0) {
    writeProfileManifest(hostDir, {
      ...manifest,
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile,
        bundles: [...bundles, ...desktopOnly.map(plugin => plugin.name)] } },
    })
  }
  syncOptionalProfileFile(join(webDir, PROFILE_PATCH_FILENAME), join(hostDir, PROFILE_PATCH_FILENAME))
  syncOptionalProfileFile(join(webDir, PROFILE_COMPATIBILITY_FILENAME), join(hostDir, PROFILE_COMPATIBILITY_FILENAME))
  writeFileSync(join(hostDir, HOST_PROFILE_ROOT_FILENAME), HOST_PROFILE_ROOT_CONFIG)
  materializeHostNodeModules(webDir, hostDir, ecosystem)
  return hostDir
}

/**
 * Copy or refresh a required profile file into the private Host projection.
 * @param source - Shared web profile file.
 * @param destination - Private Host projection path.
 */
function syncProfileFile(source: string, destination: string): void {
  if (!existsSync(source)) {
    throw new Error(`host profile: shared profile file missing at ${source}`)
  }
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination)
}

/**
 * Copy an optional profile file, or remove a stale private copy when the source is absent.
 * @param source - Shared web profile file.
 * @param destination - Private Host projection path.
 */
function syncOptionalProfileFile(source: string, destination: string): void {
  if (!existsSync(source)) {
    removeHostLink(destination)
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination)
}

/**
 * Build private `node_modules`: ecosystem names point at Electron bundles; other
 * names forward to the shared web profile install.
 * @param webDir - Shared web profile directory.
 * @param hostDir - Private Host profile directory.
 * @param ecosystem - Desktop-bundled ecosystem plugins.
 */
export function materializeHostNodeModules(
  webDir: string,
  hostDir: string,
  ecosystem: readonly RuntimePluginManifest[],
): void {
  const hostModules = join(hostDir, 'node_modules')
  const webModules = join(webDir, 'node_modules')
  mkdirSync(hostModules, { recursive: true })
  const ecosystemByName = new Map(ecosystem.map(plugin => [plugin.name, plugin]))
  clearHostModuleTree(hostModules)
  if (existsSync(webModules)) {
    linkForwardedPackages(webModules, hostModules, ecosystemByName)
  }
  for (const plugin of ecosystem) {
    ensureSymlink(join(hostModules, ...plugin.name.split('/')), plugin.rootPath)
  }
}

/**
 * Remove previous private module links so a refresh cannot leave stale names.
 * @param hostModules - Private `node_modules` directory.
 */
function clearHostModuleTree(hostModules: string): void {
  if (!existsSync(hostModules)) return
  for (const entry of readdirSync(hostModules, { withFileTypes: true })) {
    removeHostEntry(join(hostModules, entry.name))
  }
}

/** Remove an owned projection entry without traversing symlinks inside scope directories. */
function removeHostEntry(path: string): void {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    unlinkSync(path)
    return
  }
  for (const name of readdirSync(path)) removeHostEntry(join(path, name))
  rmdirSync(path)
}

/**
 * Forward non-ecosystem packages from the shared web profile into the private tree.
 * @param webModules - Shared web `node_modules`.
 * @param hostModules - Private Host `node_modules`.
 * @param ecosystemByName - Ecosystem packages Desktop owns at runtime.
 */
function linkForwardedPackages(
  webModules: string,
  hostModules: string,
  ecosystemByName: ReadonlyMap<string, RuntimePluginManifest>,
): void {
  for (const entry of readdirSync(webModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const webPath = join(webModules, entry.name)
    if (entry.name.startsWith('@')) {
      const scopeDir = join(hostModules, entry.name)
      mkdirSync(scopeDir, { recursive: true })
      if (!entry.isDirectory()) continue
      for (const child of readdirSync(webPath, { withFileTypes: true })) {
        const name = `${entry.name}/${child.name}`
        if (ecosystemByName.has(name)) continue
        ensureSymlink(join(scopeDir, child.name), join(webPath, child.name))
      }
      continue
    }
    if (ecosystemByName.has(entry.name)) continue
    ensureSymlink(join(hostModules, entry.name), webPath)
  }
}

/**
 * Whether a path is a symlink whose current target equals `expected`.
 * @param link - Candidate symlink path.
 * @param expected - Absolute target.
 * @returns True when the link already points at `expected`.
 */
export function symlinkPointsTo(link: string, expected: string): boolean {
  try {
    const current = lstatSync(link)
    return current.isSymbolicLink() && readlinkSync(link) === expected
  } catch (error: unknown) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

/**
 * Remove a private Host file or link when present.
 * @param link - File or symlink path under the private projection.
 */
export function removeHostLink(link: string): void {
  try {
    unlinkSync(link)
  } catch (error: unknown) {
    if (!isMissingPathError(error)) throw error
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
