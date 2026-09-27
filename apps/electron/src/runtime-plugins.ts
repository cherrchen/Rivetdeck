import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** Relative path from the Electron application root to bundled runtime plugins. */
export const RUNTIME_PLUGINS_RELATIVE = join('runtime', 'plugins')

/** Parsed metadata for one bundled runtime plugin directory. */
export interface RuntimePluginManifest {
  /** npm package name from package.json. */
  name: string
  /** npm package version from package.json. */
  version: string
  /** User-facing package description from package.json. */
  description?: string
  /** Naming segment for the plugin: a `runtime/plugins` child directory, or an npm package's final name segment. */
  directoryName: string
  /** Absolute path to the plugin root (contains package.json and lib/). */
  rootPath: string
  /** Whether package.json declares a dsh.client browser half. */
  hasClient: boolean
}

/** Inventory field naming one npm plugin group the Electron distribution declares. */
type NpmPluginInventory = 'runtimePlugins' | 'ecosystemPlugins'

interface ElectronPluginInventoryManifest {
  dshElectron?: {
    /** Npm packages holding the same status as `runtime/plugins/` members: Electron application capabilities. */
    runtimePlugins?: string[]
    /** Npm packages naming external public DSH plugins. */
    ecosystemPlugins?: string[]
  }
}

/** Error-message prefix for each npm inventory field. */
const NPM_INVENTORY_LABELS: Record<NpmPluginInventory, string> = {
  runtimePlugins: 'runtime plugins',
  ecosystemPlugins: 'ecosystem plugins',
}

/**
 * Absolute path of the bundled runtime plugin inventory.
 * @param appPath - Electron application root.
 * @returns Directory containing one folder per runtime plugin.
 */
export function runtimePluginsRoot(appPath: string): string {
  return join(appPath, RUNTIME_PLUGINS_RELATIVE)
}

/**
 * Discover bundled runtime plugin directories under runtime/plugins.
 * @param appPath - Electron application root.
 * @returns One manifest per direct child directory containing package.json.
 */
export function discoverRuntimePluginDirectories(appPath: string): RuntimePluginManifest[] {
  const root = runtimePluginsRoot(appPath)
  if (!existsSync(root)) {
    throw new Error(`runtime plugins: inventory missing at ${root}`)
  }
  const plugins: RuntimePluginManifest[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pluginRoot = join(root, entry.name)
    const manifestPath = join(pluginRoot, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest: PackageManifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
    } catch (error) {
      throw new Error(`runtime plugins: invalid package.json at ${manifestPath}: ${String(error)}`)
    }
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      throw new Error(`runtime plugins: package name missing in ${manifestPath}`)
    }
    if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
      throw new Error(`runtime plugins: package version missing in ${manifestPath}`)
    }
    plugins.push({
      name: manifest.name,
      version: manifest.version,
      ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
      directoryName: entry.name,
      rootPath: pluginRoot,
      hasClient: manifest.dsh?.client !== undefined,
    })
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve npm plugin packages declared by one `dshElectron` inventory field.
 * @param appPath - Electron application root.
 * @param inventory - Inventory field naming the declared package names.
 * @returns Manifests backed by installed npm package artifacts.
 */
function discoverDeclaredPlugins(appPath: string, inventory: NpmPluginInventory): RuntimePluginManifest[] {
  const label = NPM_INVENTORY_LABELS[inventory]
  const appManifestPath = join(appPath, 'package.json')
  if (!existsSync(appManifestPath)) return []
  const appManifest = JSON.parse(readFileSync(appManifestPath, 'utf8')) as ElectronPluginInventoryManifest
  const names = appManifest.dshElectron?.[inventory] ?? []
  return names.map((name) => {
    const rootPath = join(appPath, 'node_modules', ...name.split('/'))
    const manifestPath = join(rootPath, 'package.json')
    if (!existsSync(manifestPath)) {
      throw new Error(`${label}: ${name} is declared but not installed at ${rootPath}`)
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
    if (manifest.name !== name) {
      throw new Error(`${label}: expected ${name} at ${manifestPath}, found ${String(manifest.name)}`)
    }
    if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
      throw new Error(`${label}: package version missing in ${manifestPath}`)
    }
    return {
      name,
      version: manifest.version,
      ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
      directoryName: name.split('/').at(-1) ?? name,
      rootPath,
      hasClient: manifest.dsh?.client !== undefined,
    }
  })
}

/**
 * Resolve npm runtime plugins declared by `dshElectron.runtimePlugins`.
 * A runtime plugin holds the same status as a `runtime/plugins/` member.
 * @param appPath - Electron application root.
 * @returns Manifests backed by installed npm package artifacts.
 */
export function discoverRuntimePluginPackages(appPath: string): RuntimePluginManifest[] {
  return discoverDeclaredPlugins(appPath, 'runtimePlugins')
}

/**
 * Resolve npm ecosystem plugins declared by `dshElectron.ecosystemPlugins`.
 * @param appPath - Electron application root.
 * @returns Manifests backed by installed npm package artifacts.
 */
export function discoverEcosystemPluginPackages(appPath: string): RuntimePluginManifest[] {
  return discoverDeclaredPlugins(appPath, 'ecosystemPlugins')
}

interface PackageManifest {
  name?: string
  version?: string
  description?: string
  dsh?: { client?: unknown }
  exports?: Record<string, { default?: string }>
}

/** Resolve the built client bundle filename a plugin manifest declares for "./client". */
function clientBundleFile(rootPath: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf8')) as PackageManifest
    return basename(manifest.exports?.['./client']?.default ?? './lib/client.js')
  } catch {
    return 'client.js'
  }
}

/**
 * Validate that a bundled plugin has the expected built artifacts.
 * @param plugin - Discovered plugin manifest.
 */
export function validateRuntimePlugin(plugin: RuntimePluginManifest): void {
  const { rootPath, name } = plugin
  if (!existsSync(join(rootPath, 'package.json'))) {
    throw new Error(`runtime plugins: ${name} missing package.json at ${rootPath}`)
  }
  if (!existsSync(join(rootPath, 'lib', 'index.js'))) {
    throw new Error(`runtime plugins: ${name} missing lib/index.js at ${rootPath}`)
  }
  if (plugin.hasClient) {
    const clientFile = clientBundleFile(rootPath)
    if (!existsSync(join(rootPath, 'lib', clientFile))) {
      throw new Error(`runtime plugins: ${name} missing lib/${clientFile} at ${rootPath}`)
    }
  }
}

/**
 * Resolve the profile node_modules link path for one npm package name.
 * @param harnessHome - `$DSH_HOME` root used by the supervised Host.
 * @param packageName - Scoped or unscoped npm package name.
 * @returns Absolute symlink path under profiles/node_modules.
 */
export function profileModuleLinkPath(harnessHome: string, packageName: string): string {
  return join(harnessHome, 'profiles', 'node_modules', ...packageName.split('/'))
}

/**
 * Resolve the web profile node_modules link path for one npm package name.
 * Desktop boot restores this link so a same-named CLI install cannot shadow
 * the application copy.
 * @param harnessHome - `$DSH_HOME` root used by the supervised Host.
 * @param packageName - Scoped or unscoped npm package name.
 * @returns Absolute symlink path under profiles/web/node_modules.
 */
export function webProfileModuleLinkPath(harnessHome: string, packageName: string): string {
  return join(harnessHome, 'profiles', 'web', 'node_modules', ...packageName.split('/'))
}

/**
 * Validate and link bundled Desktop plugins into profile resolution before Host boot.
 * Every Electron boot restores Desktop-owned package links under both
 * `$DSH_HOME/profiles/node_modules` and `$DSH_HOME/profiles/web/node_modules`.
 * @param appPath - Electron application root.
 * @param harnessHome - Active Harness home.
 */
export function ensureRuntimePluginsLinked(appPath: string, harnessHome: string): void {
  const plugins = [
    ...discoverRuntimePluginDirectories(appPath),
    ...discoverRuntimePluginPackages(appPath),
    ...discoverEcosystemPluginPackages(appPath),
  ]
  if (plugins.length === 0) throw new Error(`runtime plugins: no bundled plugins under ${runtimePluginsRoot(appPath)}`)
  for (const plugin of plugins) validateRuntimePlugin(plugin)
  for (const plugin of plugins) {
    ensureSymlink(profileModuleLinkPath(harnessHome, plugin.name), plugin.rootPath)
    ensureSymlink(webProfileModuleLinkPath(harnessHome, plugin.name), plugin.rootPath)
  }
}

/**
 * Create or repair a directory symlink (junction on Windows).
 * @param link - Symlink path under profiles/node_modules.
 * @param target - Absolute plugin directory.
 */
export function ensureSymlink(link: string, target: string): void {
  mkdirSync(dirname(link), { recursive: true })
  let current: ReturnType<typeof lstatSync>
  try {
    current = lstatSync(link)
  } catch (error: unknown) {
    if (!isMissingPathError(error)) throw error
    symlinkSync(target, link, 'junction')
    return
  }
  if (current.isSymbolicLink()) {
    if (readlinkSync(link) === target) return
    unlinkSync(link)
  } else {
    // A prior profile install may have placed a real package here. Retain it for recovery.
    renameSync(link, `${link}.desktop-replaced-${randomUUID()}`)
  }
  symlinkSync(target, link, 'junction')
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
