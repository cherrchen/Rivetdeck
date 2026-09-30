/** Electron's applied package generation and serialized shared-profile reconciliation. */
import { existsSync, realpathSync, writeFileSync, renameSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-hmr'
import {
  composeEntries, createRuntimeResolution, loadProfileDirectory,
  readProfileManifest, readProfilePatches, reconcileProfilePatches, resolveBundleDir,
  PROFILE_COMPATIBILITY_FILENAME,
  type ProfileContext, type ProfileManifest, type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { prepareHostProfileProjection } from './host-profile.ts'
import { flattenEntries, generateOwnershipOverlay } from './ownership-overlay.ts'
import { discoverEcosystemPluginPackages, discoverRuntimePluginDirectories, discoverRuntimePluginPackages } from './runtime-plugins.ts'
import { load } from 'js-yaml'

/** Package identity committed with the Electron Loader composition. */
export interface DesktopRuntimePackage {
  name: string
  dir: string
  manifest: ProfileManifest
  source: 'application' | 'profile'
  required: boolean
  enabled: boolean
}

interface Generation {
  patches: PatchOptions[]
  packages: DesktopRuntimePackage[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Electron runtime composition; shared profile persistence remains in profileContext. */
    desktopRuntime: DesktopRuntime
  }
}

/** Own one Host's mixed package selection, without owning profile package persistence. */
export class DesktopRuntime {
  private current: Generation
  private readonly owned: Map<string, { rootPath: string; required: boolean }>
  private readonly hostDir: string
  private resolution?: RuntimeResolution

  constructor(private readonly appPath: string, private readonly profile: ProfileContext) {
    this.owned = new Map<string, { rootPath: string; required: boolean }>([
      ...discoverEcosystemPluginPackages(appPath).map(pkg => [pkg.name, { ...pkg, required: false }] as const),
      ...[...discoverRuntimePluginDirectories(appPath), ...discoverRuntimePluginPackages(appPath)]
        .map(pkg => [pkg.name, { ...pkg, required: true }] as const),
    ])
    const hostDir = prepareHostProfileProjection(appPath, profile.home)
    if (hostDir === undefined) throw new Error('Electron runtime requires the shared web profile')
    this.hostDir = hostDir
    this.current = this.readGeneration()
  }

  /** Read the last applied composition. @returns Detached patches for the Loader. */
  patches(): PatchOptions[] { return structuredClone(this.current.patches) }

  /** Read package identities from the applied generation. @returns Effective runtime packages. */
  packages(): readonly DesktopRuntimePackage[] { return this.current.packages }

  /** Construct the installation resolver; profile package selection belongs to this runtime.
   * @returns Stable installation mappings and Host resolution scope.
   */
  async initialResolution(): Promise<RuntimeResolution> {
    const profile = loadProfileDirectory('dsh', this.hostDir, this.profile.installAnchor)
    const resolution = await createRuntimeResolution({
      installAnchor: this.profile.installAnchor,
      profile: { ...profile, layers: [] }, home: this.profile.home,
    })
    this.resolution = { ...resolution, localPackageNames: [] }
    return this.resolution
  }

  /** Install package routing for this Host only.
   * @param ctx Root context owning the resolver lifetime.
   */
  install(ctx: Context): void {
    const hostPrefixes = [this.hostDir, realpathSync(this.hostDir)].map(dir => pathToFileURL(dir + '/').href)
    const hooks = registerHooks({
      resolve: (specifier, context, nextResolve) => {
        const pkg = this.current.packages.find(pkg => specifier === pkg.name || specifier.startsWith(pkg.name + '/'))
        if (pkg === undefined || (!this.owned.has(pkg.name)
          && !hostPrefixes.some(prefix => context.parentURL?.startsWith(prefix)))) return nextResolve(specifier, context)
        return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(pkg.dir, 'package.json')).href })
      },
    })
    ctx.effect(() => () => { hooks.deregister() }, 'Electron runtime package routing')
  }

  /** Register shared persistence watches on the existing HMR queue.
   * @param ctx Runtime adapter context with HMR and application readiness.
   */
  async watch(ctx: Context): Promise<void> {
    const ready = Promise.withResolvers<boolean>()
    const appReady = ctx.get('appReady')
    if (appReady === undefined) throw new Error('Electron runtime watches require application readiness')
    const unsubscribe = appReady.onReady(() => { ready.resolve(true); this.writeDiagnostics(ctx) })
    ctx.effect(() => () => { unsubscribe(); ready.resolve(false) }, 'Electron profile readiness')
    const refresh = async (): Promise<void> => {
      if (await ready.promise) await this.reconcileLocked(ctx)
    }
    for (const filename of [join(this.profile.dir, 'package.json'), join(this.profile.dir, 'pnpm-lock.yaml'),
      this.profile.patchPath, join(this.profile.home, 'cordis.patch.yml'),
      join(this.profile.dir, PROFILE_COMPATIBILITY_FILENAME)]) {
      await ctx.effect(() => ctx.hmr.watchConfig(filename, refresh), 'Electron profile watch')
    }
  }

  /** Apply settled persistence through HMR; callers must have released the package writer lock.
   * @param ctx Host context.
   * @returns Completion after Loader unloads and activations settle.
   */
  async refresh(ctx: Context): Promise<void> {
    await ctx.hmr.runExclusive(() => this.reconcileLocked(ctx))
  }

  private async reconcileLocked(ctx: Context): Promise<void> {
    await withFileLock(join(this.profile.dir, 'package.json'), async () => {
      prepareHostProfileProjection(this.appPath, this.profile.home)
      const next = this.readGeneration()
      const previous = this.current
      const changed = new Set(previous.packages.filter((pkg) => {
        const successor = next.packages.find(candidate => candidate.name === pkg.name)
        return successor === undefined || successor.dir !== pkg.dir || successor.manifest.version !== pkg.manifest.version
      }).map(pkg => pkg.name))
      for (const entry of ctx.loader.entries()) {
        if (![...changed].some(name => entry.options.name === name || entry.options.name.startsWith(name + '/'))) continue
        const fiber = entry.fiber
        await entry.update({ disabled: true })
        await fiber?.dispose()
      }
      // Package managers can replace file: artifacts at the same physical directory.
      // Disposal precedes cache eviction so the next Loader import reads the new code.
      const prefixes = previous.packages.filter(pkg => changed.has(pkg.name))
        .map(pkg => pathToFileURL(pkg.dir + '/').href)
      const internal = ctx.loader.internal
      if (internal === undefined) throw new Error('Electron runtime requires the Node module loader')
      for (const url of internal.loadCache.keys()) {
        if (prefixes.some(prefix => url.startsWith(prefix))) Map.prototype.delete.call(internal.loadCache, url)
      }
      const require = createRequire(import.meta.url)
      for (const filename of Object.keys(require.cache)) {
        if (prefixes.some(prefix => pathToFileURL(filename).href.startsWith(prefix))) Reflect.deleteProperty(require.cache, filename)
      }
      this.current = next
      if (this.resolution === undefined) throw new Error('Electron runtime resolution is not initialized')
      ctx.pluginPackages.replace(this.resolution)
      try {
        await reconcileProfilePatches(ctx.root, next.patches, 'dsh')
      } finally {
        this.writeDiagnostics(ctx)
        ctx.emit('plugin-manager/changed', { reason: 'bundle' })
      }
    })
  }

  /** Export observed resolver and Loader facts for support diagnostics; never read as configuration.
   * @param ctx Host context whose resolver and Loader are inspected.
   */
  writeDiagnostics(ctx: Context): void {
    const parent = pathToFileURL(join(this.hostDir, 'cordis.yml')).href
    const entries = [...ctx.loader.entries()]
    const packages = this.current.packages.map((pkg) => {
      const resolved = ctx.pluginPackages.packageOf(pkg.name, parent)
      if (resolved === undefined || realpathSync(resolved.dir) !== pkg.dir || resolved.version !== pkg.manifest.version) {
        throw new Error(`Electron runtime inventory differs from package resolution: ${pkg.name}`)
      }
      return {
        packageName: pkg.name,
        version: resolved.version,
        resolvedPath: realpathSync(resolved.dir),
        modulePath: (() => {
          const loader = ctx.loader.internal
          if (loader === undefined) throw new Error('Electron runtime requires the Node module resolver')
          const result = loader.version === 'v2'
            ? loader.resolveSync(parent, { specifier: pkg.name, attributes: {} })
            : loader.resolveSync(pkg.name, parent, {})
          return fileURLToPath(result.url)
        })(),
        source: pkg.source,
        enabled: pkg.enabled,
        manageable: !pkg.required,
        removable: !pkg.required && pkg.source === 'profile',
        loaderEntries: entries.filter(entry => entry.options.name === pkg.name || entry.options.name.startsWith(pkg.name + '/')).map(entry => ({
          id: entry.id, enabled: !entry.disabled, fiberPhase: entry.fiber?.state ?? null,
        })),
      }
    })
    const target = join(this.profile.home, 'electron', 'runtime-inventory.json')
    writeFileSync(target + '.tmp', JSON.stringify({ packages }, null, 2) + '\n')
    renameSync(target + '.tmp', target)
  }

  private readGeneration(): Generation {
    const profile = loadProfileDirectory('dsh', this.hostDir, this.profile.installAnchor)
    const parsed: unknown = load(generateOwnershipOverlay(this.appPath, this.profile.home))
    if (!Array.isArray(parsed)) throw new Error('Electron ownership overlay must be a patch list')
    const patches = readProfilePatches('dsh', {
      ...this.profile, dir: this.hostDir, overlays: parsed as PatchOptions[],
    }, profile)
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const selected = new Set(readProfileManifest('dsh', this.hostDir).dsh?.profile?.bundles ?? [])
    const rows = flattenEntries(composeEntries([patches]))
    const names = new Set([...selected, ...Object.keys(manifest.dependencies ?? {}), ...this.owned.keys()])
    const packages: DesktopRuntimePackage[] = []
    for (const name of names) {
      const owner = this.owned.get(name)
      const path = owner?.rootPath ?? (existsSync(join(this.profile.dir, 'node_modules', name, 'package.json'))
        ? join(this.profile.dir, 'node_modules', name)
        : selected.has(name) ? resolveBundleDir('dsh', name, this.profile.installAnchor, this.hostDir) : undefined)
      if (path === undefined) continue
      if (!existsSync(join(path, 'package.json'))) continue
      const dir = realpathSync(path)
      const info = readProfileManifest('dsh', dir)
      if (info.dsh?.bundle === undefined && owner === undefined) continue
      const profileOwned = owner === undefined && existsSync(join(this.profile.dir, 'node_modules', name, 'package.json'))
      const declaredRows = rows.filter(row => row.name === name || row.name.startsWith(name + '/'))
      packages.push({ name, dir, manifest: info, source: profileOwned ? 'profile' : 'application',
        required: owner?.required ?? !profileOwned,
        enabled: declaredRows.length > 0 ? declaredRows.some(row => !row.disabled) : selected.has(name),
      })
    }
    return { patches, packages }
  }
}
