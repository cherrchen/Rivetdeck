/** Prepare the shared web profile through the same package operation as `dsh plugin`. */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { runPluginCommand, type PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import { readProfileManifest, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { discoverEcosystemPluginPackages, ensureRuntimePluginsLinked, type RuntimePluginManifest } from './runtime-plugins.ts'
import { resolveDshInstallAnchor } from './runtime.ts'

/** Profile name the supervised Host and CLI share for persistence. */
export const WEB_PROFILE_NAME = 'web'

const SEED_MARKER = join('electron', 'ecosystem-preinstalled')

/** Package runner supplied by the Core executor and bundled pnpm. */
export type EcosystemPackageManager = Pick<PackageOperationOptions, 'command' | 'args' | 'env' | 'signal'>

/** Initialize the Core profile without registry access; bundled plugins resolve in its Host projection.
 * @param appPath Application-owned packages.
 * @param harnessHome Profile persistence directory.
 * @param packageManager Core executor and bundled pnpm.
 */
export async function prepareCoreProfile(appPath: string, harnessHome: string, packageManager: EcosystemPackageManager): Promise<void> {
  ensureRuntimePluginsLinked(appPath, harnessHome)
  const dir = resolveProfileDir(WEB_PROFILE_NAME, harnessHome)
  if (existsSync(join(dir, 'package.json'))) return
  await manage(['install', '--offline', '--config.auto-install-peers=false'], appPath, harnessHome, packageManager)
}

/**
 * Preinstall ecosystem packages once and repair links left by older Desktop releases.
 * Ecosystem installation files are changed only by the shared `dsh plugin` operation.
 * Existing dependency versions and disabled bundle selections are retained.
 * @param appPath - Electron application root holding ecosystem packages.
 * @param harnessHome - Active `$DSH_HOME`.
 * @param packageManager - Bundled package-manager invocation.
 */
export async function prepareEcosystemProfile(
  appPath: string,
  harnessHome: string,
  packageManager: EcosystemPackageManager,
): Promise<void> {
  const dir = resolveProfileDir(WEB_PROFILE_NAME, harnessHome)
  mkdirSync(dir, { recursive: true })
  ensureRuntimePluginsLinked(appPath, harnessHome)
  const ecosystem = discoverEcosystemPluginPackages(appPath)
  const marker = join(harnessHome, SEED_MARKER)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(marker)) {
    const dependencies = existsSync(manifestPath)
      ? readProfileManifest('dsh', dir).dependencies ?? {}
      : {}
    const appManifest = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const missing = ecosystem.filter(plugin => !Object.hasOwn(dependencies, plugin.name)).map((plugin) => {
      const pin = appManifest.dependencies?.[plugin.name]
      if (pin !== plugin.version) throw new Error(`ecosystem profile: ${plugin.name} has no matching exact pin`)
      return `${plugin.name}@${pin}`
    })
    if (missing.length > 0) await manage(['add', ...missing], appPath, harnessHome, packageManager)
    else if (!existsSync(manifestPath)) await manage(['install'], appPath, harnessHome, packageManager)
    mkdirSync(dirname(marker), { recursive: true })
    await writeFileAtomic(marker, 'Ecosystem preinstall completed.\n', { mode: 0o600 })
  }
  if (!existsSync(manifestPath)) await manage(['install'], appPath, harnessHome, packageManager)
  const dependencies = readProfileManifest('dsh', dir).dependencies ?? {}
  const legacy = ecosystem.filter(plugin => Object.hasOwn(dependencies, plugin.name)
    && hasLegacyDesktopLink(dir, plugin))
  if (legacy.length > 0) {
    await manage(['add', ...legacy.map(plugin => `${plugin.name}@${dependencies[plugin.name]}`), '--force'],
      appPath, harnessHome, packageManager)
  }
  const missingInstalled = ecosystem.filter(plugin => Object.hasOwn(dependencies, plugin.name)
    && !existsSync(join(dir, 'node_modules', ...plugin.name.split('/'), 'package.json')))
  if (missingInstalled.length > 0) await manage(['install', '--force'], appPath, harnessHome, packageManager)
  const remaining = ecosystem.filter(plugin => Object.hasOwn(dependencies, plugin.name)
    && (!existsSync(join(dir, 'node_modules', ...plugin.name.split('/'), 'package.json'))
      || hasLegacyDesktopLink(dir, plugin)))
  if (remaining.length > 0) {
    throw new Error(`ecosystem profile: package manager did not repair ${remaining.map(plugin => plugin.name).join(', ')}`)
  }
}

/**
 * Detect an ecosystem link left by a Desktop application, including a dangling link.
 * @param profileDir - Shared web profile directory.
 * @param plugin - Bundled ecosystem package to inspect.
 * @returns Whether this package link points to a Desktop application copy.
 */
export function hasLegacyDesktopLink(profileDir: string, plugin: RuntimePluginManifest): boolean {
  const packagePath = join(profileDir, 'node_modules', ...plugin.name.split('/'))
  let target: string
  try {
    if (!lstatSync(packagePath).isSymbolicLink()) return false
    target = readlinkSync(packagePath)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
  const resolvedTarget = resolve(dirname(packagePath), target)
  const profileRelative = relative(profileDir, resolvedTarget)
  if (!profileRelative.startsWith('..') && !isAbsolute(profileRelative)) return false
  if (resolvedTarget === resolve(plugin.rootPath)) return true
  const suffix = join('node_modules', ...plugin.name.split('/'))
  if (!resolvedTarget.endsWith(suffix)) return false
  const appRoot = resolvedTarget.slice(0, -suffix.length)
  const appManifestPath = join(appRoot, 'package.json')
  if (!existsSync(appManifestPath)) return true
  const appManifest = JSON.parse(readFileSync(appManifestPath, 'utf8')) as {
    dshElectron?: { ecosystemPlugins?: string[] }
  }
  return appManifest.dshElectron?.ecosystemPlugins?.includes(plugin.name) === true
}

async function manage(
  args: readonly string[], appPath: string, harnessHome: string, packageManager: EcosystemPackageManager,
): Promise<void> {
  const result = await runPluginCommand({
    profile: WEB_PROFILE_NAME,
    installAnchor: resolveDshInstallAnchor(appPath),
    cwd: appPath,
    home: harnessHome,
  }, args, { ...packageManager, execution: 'service', outputBytes: 16 * 1024 })
  if (result.exitCode !== 0 || result.timedOut === true) {
    throw new Error(`ecosystem profile: dsh plugin ${args[0]} failed: ${result.output}`)
  }
}
