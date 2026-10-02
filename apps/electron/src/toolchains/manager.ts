/** Main owns privileged runtime state. Host receives only the verified startup snapshot. */
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { loadManifest } from '../../scripts/toolchains/manifest.mjs'
import { writeDesktopFileAtomic } from '../atomic-file.ts'
import { DesktopPreferencesStore } from '../preferences.ts'
import { installRuntime, RuntimeInstallError, verifyRuntime, type RuntimeFetch } from './installer.ts'
import { runtimePaths } from './paths.ts'
import { readRuntimeReceipt, receiptLocation, type RuntimeReceipt } from './resolver.ts'
import type { DesktopToolchains, RuntimeName, RuntimeSnapshot, RuntimeState } from './domain.ts'

/** Main manager dependencies use the already configured Electron network transport. */
export interface RuntimeManagerOptions {
  userData: string
  fetch: RuntimeFetch
  platform?: NodeJS.Platform
  arch?: string
  verify?: typeof verifyRuntime
  manifest?: ReturnType<typeof loadManifest>
}
/** Independent Node/Python operations, immutable generations, and restart-safe removals. */
export class RuntimeManager {
  private readonly root: string
  private readonly target: string
  private readonly platform: NodeJS.Platform
  private readonly lock: ReturnType<typeof loadManifest>
  private readonly preferences: DesktopPreferencesStore
  private readonly listeners = new Set<(snapshot: RuntimeSnapshot) => void>()
  private readonly operations = new Map<RuntimeName, { abort: AbortController; done: Promise<void> }>()
  private readonly receipts = new Map<RuntimeName, RuntimeReceipt>()
  private readonly states: Record<RuntimeName, RuntimeState>
  private onboardingCompleted: boolean
  private closing = false
  private toolchains: DesktopToolchains = {}

  /** @param options User-data ownership and Main network adapter. */
  constructor(private readonly options: RuntimeManagerOptions) {
    this.lock = options.manifest ?? loadManifest()
    this.root = join(options.userData, 'managed-toolchains')
    this.platform = options.platform ?? process.platform
    this.target = `${this.platform}-${options.arch ?? process.arch}`
    if (!(this.target in this.lock.node.targets)) throw new Error('desktop runtimes: unsupported target')
    this.preferences = new DesktopPreferencesStore(options.userData)
    this.onboardingCompleted = this.preferences.load().preferences.runtimeOnboardingCompleted === true
    this.states = {
      node: { name: 'node', version: this.lock.node.version, phase: 'not-installed', restartRequired: false },
      python: { name: 'python', version: this.lock.python.version, phase: 'not-installed', restartRequired: false },
    }
  }

  /** Verify selections and finish deferred deletion before any Host can use them.
   * @returns Optional startup executables; an invalid runtime is reported individually.
   */
  async prepare(): Promise<DesktopToolchains> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await rm(join(this.root, 'staging'), { recursive: true, force: true })
    for (const name of ['node', 'python'] as const) {
      const pending = join(this.root, name, 'installation.pending')
      const interrupted = existsSync(pending)
      try {
        const receipt = readRuntimeReceipt(this.root, name)
        if (receipt === undefined) {
          if (interrupted) this.set(name, { phase: 'failed', error: 'interrupted' })
          continue
        }
        for (const retired of receipt.retired) {
          await rm(receiptLocation(this.root, name, this.target, retired), { recursive: true, force: true })
        }
        const location = receiptLocation(this.root, name, this.target, receipt)
        if (receipt.pendingRemoval) {
          await rm(location, { recursive: true, force: true })
          await rm(join(this.root, name, 'active.json'), { force: true })
          continue
        }
        receipt.retired = []
        this.receipts.set(name, receipt)
        await this.writeReceipt(name, receipt)
        this.set(name, { installedVersion: receipt.version, location })
        await (this.options.verify ?? verifyRuntime)(name, location, receipt.version, this.platform)
        this.toolchains = { ...this.toolchains, ...runtimePaths(name, location, receipt.version, this.platform) }
        this.set(name, { phase: receipt.version === this.lock[name].version ? 'installed' : 'update-available', installedVersion: receipt.version, location })
      } catch (error) {
        console.error(`desktop ${name} runtime validation failed`, error)
        this.set(name, { phase: 'failed', error: 'corrupt' })
      } finally {
        await rm(pending, { force: true })
        if (interrupted) this.set(name, { phase: 'failed', error: 'interrupted' })
      }
    }
    return this.toolchains
  }

  /** @returns A detached sanitized snapshot shared by every client view. */
  state(): RuntimeSnapshot {
    return { onboardingCompleted: this.onboardingCompleted, node: { ...this.states.node }, python: { ...this.states.python } }
  }
  /** @param listener Observer invoked immediately and on every mutation.
   * @returns Subscription disposer.
   */
  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.state())
    return () => { this.listeners.delete(listener) }
  }
  /** Persist Skip or explicit install consent independently from installation success. */
  async completeOnboarding(): Promise<void> {
    await this.preferences.update({ runtimeOnboardingCompleted: true })
    this.onboardingCompleted = true
    this.emit()
  }
  /** Queue one independent installation; duplicate operations reuse the existing completion.
   * @param name Runtime selected explicitly by the user.
   * @returns Resolves after success or a reported failure; Main logs retain technical errors.
   */
  install(name: RuntimeName): Promise<void> {
    if (this.closing) return Promise.reject(new Error('desktop runtimes: shutting down'))
    const existing = this.operations.get(name)
    if (existing !== undefined) return existing.done
    const abort = new AbortController()
    const done = Promise.resolve().then(async () => {
      await this.performInstall(name, abort.signal)
    }).finally(() => { this.operations.delete(name) })
    this.operations.set(name, { abort, done })
    return done
  }
  /** Cancel and await extraction/download cleanup.
   * @param name Selected active operation.
   */
  async cancel(name: RuntimeName): Promise<void> {
    const operation = this.operations.get(name)
    operation?.abort.abort()
    await operation?.done
  }
  /** Defer all deletion until Host shutdown, including newly installed executables used by explicit paths.
   * @param name Managed runtime only; project and Core files are outside these paths.
   */
  remove(name: RuntimeName): Promise<void> {
    if (this.closing || this.operations.has(name)) return Promise.reject(new Error('desktop runtimes: operation in progress'))
    const done = Promise.resolve().then(async () => { await this.performRemove(name) }).finally(() => { this.operations.delete(name) })
    this.operations.set(name, { abort: new AbortController(), done })
    return done
  }
  private async performRemove(name: RuntimeName): Promise<void> {
    const receipt = this.receipts.get(name)
    if (receipt === undefined) return
    this.set(name, { phase: 'removing', error: undefined })
    try {
      const pending = { ...receipt, pendingRemoval: true }
      await this.writeReceipt(name, pending)
      this.receipts.set(name, pending)
      this.set(name, { restartRequired: true })
    } catch (error) {
      console.error(`desktop ${name} removal failed`, error)
      this.set(name, { phase: 'failed', error: 'operation' })
    }
  }
  /** Abort operations and wait for their filesystem work to stop before quit. */
  async shutdown(): Promise<void> {
    this.closing = true
    this.listeners.clear()
    await Promise.all([...this.operations.keys()].map(async (name) => { await this.cancel(name) }))
  }
  private async performInstall(name: RuntimeName, signal: AbortSignal): Promise<void> {
    const previous = this.receipts.get(name)
    const version = this.lock[name].version
    const generation = randomUUID()
    const targets: Record<string, { url: string; sha256: string; archive: string }> = this.lock[name].targets
    const entry = targets[this.target]
    if (entry === undefined) throw new Error('desktop runtimes: missing pinned target')
    const receipt: RuntimeReceipt = {
      version, generation, sha256: entry.sha256, pendingRemoval: false,
      retired: previous === undefined ? [] : [...previous.retired, { version: previous.version, generation: previous.generation }],
    }
    const destination = receiptLocation(this.root, name, this.target, receipt)
    let committed = false
    const pending = join(this.root, name, 'installation.pending')
    try {
      await mkdir(join(this.root, name), { recursive: true, mode: 0o700 })
      await writeDesktopFileAtomic(pending, `${generation}\n`)
      this.set(name, { error: undefined, received: 0, total: undefined })
      await installRuntime({ name, version, entry, destination, staging: join(this.root, 'staging', generation), platform: this.platform, fetch: this.options.fetch, signal,
        ...(this.options.verify === undefined ? {} : { verify: this.options.verify }),
        phase: (phase, received, total) => { this.set(name, { phase, received, total }) },
      })
      signal.throwIfAborted()
      await this.writeReceipt(name, receipt)
      committed = true
      this.receipts.set(name, receipt)
      this.set(name, { phase: 'installed', installedVersion: version, location: destination, received: undefined, total: undefined, restartRequired: true })
    } catch (error) {
      console.error(`desktop ${name} installation failed`, error)
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
      this.set(name, { phase: 'failed', error: error instanceof RuntimeInstallError ? error.code : signal.aborted ? 'interrupted' : code === 'ENOSPC' ? 'disk' : 'operation' })
    } finally {
      if (!committed) await rm(destination, { recursive: true, force: true })
      await rm(pending, { force: true })
    }
  }
  private async writeReceipt(name: RuntimeName, receipt: RuntimeReceipt): Promise<void> {
    const directory = join(this.root, name)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeDesktopFileAtomic(join(directory, 'active.json'), `${JSON.stringify(receipt)}\n`)
  }
  private set(name: RuntimeName, patch: Partial<RuntimeState>): void {
    this.states[name] = { ...this.states[name], ...patch }
    this.emit()
  }
  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(this.state()) } catch (error) { console.error('desktop runtime subscriber failed', error) }
    }
  }
}
