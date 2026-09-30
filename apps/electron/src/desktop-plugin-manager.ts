/** Electron runtime inventory with upstream-owned shared-profile package operations. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { PluginManager, type Config, type BundleInfo, type PluginInfo, type ChangeResult,
  type InstallBundleOptions } from '@deepseek-ai/dsh-plugin-manager'
import { bundlePatchPaths, composeEntries, loadOverlayPatches, readPluginMeta } from '@deepseek-ai/dsh-app-boot'
import { readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import { runPluginCommand } from '@deepseek-ai/dsh-plugin-manager/operations'
import { flattenEntries } from './ownership-overlay.ts'
import type { DesktopRuntimePackage } from './desktop-runtime.ts'

/** Reuse package persistence while reporting the Electron Host's applied packages. */
export class DesktopPluginManager extends PluginManager {
  static override inject = [...PluginManager.inject, 'desktopRuntime', 'pluginPackages', 'hmr']
  private readonly host: Context

  constructor(ctx: Context, config: Config) {
    // Profile package operations retain their upstream writer lock. Runtime application
    // runs after that lock is released, on the Host's HMR queue.
    super(ctx.isolate('hmr'), config)
    this.host = ctx
  }

  override async listPlugins(): Promise<PluginInfo[]> {
    const snapshot = await readPluginInventory(this.host)
    const upstream = await super.listPlugins()
    return snapshot.entries.map((entry) => {
      const actual = [...this.host.loader.entries()].find(row => row.id === entry.entryId)
      const pkg = this.host.desktopRuntime.packages().find(pkg => entry.moduleName === pkg.name || entry.moduleName.startsWith(pkg.name + '/'))
      return pkg?.required === true || actual?.options.id === undefined
        || actual.options.name === 'cordis:desktop-plugin-manager'
        || upstream.find(row => row.entryId === entry.entryId)?.readOnlyReason === 'management-required'
        ? { ...entry, readOnlyReason: 'management-required' as const }
        : { ...entry, patchId: actual.options.id }
    })
  }

  /** List manageable packages; required Desktop components use the Official card and plugin inventory.
   * @returns Ecosystem and profile bundles, plus available optional bundles.
   */
  override async listBundles(): Promise<BundleInfo[]> {
    this.host.desktopRuntime.writeDiagnostics(this.host)
    const effective = this.host.desktopRuntime.packages().filter(pkg => !pkg.required).map(pkg => this.bundleInfo(pkg))
    const optional = (await super.listBundles()).filter(pkg => pkg.optional && !effective.some(row => row.name === pkg.name))
    return [...effective, ...optional]
  }

  override async setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult> {
    const pkg = this.host.desktopRuntime.packages().find(pkg => pkg.name === name)
    if (pkg?.required) return { changed: false, application: 'failed', stage: 'enable', target: name,
      enabled, error: { code: 'management-required' } }
    // A removed ecosystem package has no CLI bundle layer. Its Loader rows still
    // accept ordinary profile patches, which preserve explicit activation intent.
    if (pkg?.source === 'application') {
      const ids = new Set(this.bundleInfo(pkg).rows.flatMap(row => row.entryId === undefined ? [] : [row.entryId]))
      const entries = (await this.listPlugins()).filter(row => ids.has(row.entryId))
      if (entries.length > 0) {
        const results = await Promise.all(entries.map(row => super.setPluginEnabled(row.entryId, enabled)))
        await this.host.desktopRuntime.refresh(this.host)
        const failed = results.find(result => result.error !== undefined)
        return { changed: results.some(result => result.changed), application: failed === undefined ? 'applied' : 'failed',
          stage: 'enable', target: name, enabled, ...failed?.error === undefined ? {} : { error: failed.error } }
      }
    }
    return this.apply(await super.setBundleEnabled(name, enabled))
  }

  override async setPluginEnabled(id: Parameters<PluginManager['setPluginEnabled']>[0], enabled: boolean): Promise<ChangeResult> {
    return this.apply(await super.setPluginEnabled(id, enabled))
  }

  override async installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult> {
    return this.apply(await super.installBundle(spec, options))
  }

  override async setVersionExemption(
    packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk?: boolean,
  ): Promise<ChangeResult> {
    return this.apply(await super.setVersionExemption(packageVersion, runtimeVersion, enabled, acceptRisk))
  }

  override async removeBundle(name: string): Promise<ChangeResult> {
    const pkg = this.host.desktopRuntime.packages().find(pkg => pkg.name === name)
    if (pkg === undefined || pkg.source !== 'profile' || pkg.required) {
      return { changed: false, application: 'failed', stage: 'remove', target: name, error: { code: 'not-removable' } }
    }
    const profile = this.host.profileContext
    const result = await runPluginCommand({ profile: profile.name, dir: profile.dir,
      home: profile.home, cwd: profile.cwd, installAnchor: profile.installAnchor }, ['remove', name], {
      ...profile.packageManager, execution: 'service', outputBytes: 16384,
    })
    await this.host.desktopRuntime.refresh(this.host)
    return { changed: result.exitCode === 0, application: result.exitCode === 0 ? 'applied' : 'failed',
      stage: 'remove', target: name, packageResult: result }
  }

  private async apply(result: ChangeResult): Promise<ChangeResult> {
    await this.host.desktopRuntime.refresh(this.host)
    return result.application === 'restart-required' ? { ...result, application: 'applied' } : result
  }

  private bundleInfo(pkg: DesktopRuntimePackage): BundleInfo {
    const bundle = pkg.manifest.dsh?.bundle
    const patches = bundle === undefined ? [] : bundlePatchPaths(pkg.dir, bundle).flatMap(path => loadOverlayPatches('dsh', path))
    const declarations = flattenEntries(composeEntries([patches.filter(patch => patch.insert !== undefined)]))
    const live = [...this.host.loader.entries()]
    const rows: BundleInfo['rows'] = declarations.map((row) => {
      const actual = live.find(entry => entry.options.id === row.id && entry.options.name === row.name)
      return { rowId: row.id, moduleName: row.name,
        ...actual === undefined ? {} : { entryId: actual.id as PluginInfo['entryId'] } }
    })
    const declared = new Set(rows.map(row => row.rowId))
    const meta = readPluginMeta(pkg.name, pathToFileURL(join(pkg.dir, 'package.json')).href)
    const source = pkg.source === 'application'
      ? { en: 'Electron bundled', zh: 'Electron 内置' }
      : { en: 'Profile / user-installed', zh: 'Profile / 用户安装' }
    const description = meta?.description ?? pkg.manifest.description ?? ''
    const localized = (language: 'en' | 'zh'): string => {
      const text = typeof description === 'string' ? description : description[language] ?? description.en
      return text === '' ? source[language] : `${text} · ${source[language]}`
    }
    return {
      name: pkg.name,
      ...pkg.manifest.version === undefined ? {} : { version: pkg.manifest.version },
      ...pkg.manifest.description === undefined ? {} : { description: pkg.manifest.description },
      meta: { ...meta, description: { en: localized('en'), zh: localized('zh') } },
      installed: true, optional: false, enabled: pkg.enabled,
      removable: pkg.source === 'profile' && !pkg.required,
      ...(pkg.required ? { readOnlyReason: 'management-required' as const } : {}),
      rows, overrides: patches.flatMap(patch => patch.insert === undefined && typeof patch.id === 'string'
        && !declared.has(patch.id) ? [patch.id] : []),
    }
  }
}
