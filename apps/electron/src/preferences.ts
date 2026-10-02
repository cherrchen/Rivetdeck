import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withDesktopFileWriter, writeDesktopFileAtomic } from './atomic-file.ts'
import type {
  DesktopNetworkMode,
  DesktopNetworkPreferenceWarning,
  DesktopNetworkTestSettings,
  PersistedManualProxy,
} from './network/domain.ts'
import {
  DEFAULT_NETWORK_TEST_SETTINGS,
  normalizeHttpUrl,
  parsePersistedManualProxy,
} from './network/validation.ts'

/** Update streams exposed by the desktop application. */
export type UpdateChannel = 'prerelease' | 'stable'

/** Default update stream for new and unreadable desktop preferences. */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'prerelease'

/** Current on-disk Desktop preferences version. */
export const DESKTOP_PREFERENCES_VERSION = 1 as const

/** Password-free Network preferences stored beside other Desktop settings. */
export interface DesktopNetworkPreferencesV1 {
  mode: DesktopNetworkMode
  manual?: PersistedManualProxy
  proxyAgentTraffic: boolean
  tests: DesktopNetworkTestSettings
}

/** Complete versioned Desktop-owned preference document. */
export interface DesktopPreferencesV1 {
  version: typeof DESKTOP_PREFERENCES_VERSION
  updateChannel: UpdateChannel
  network: DesktopNetworkPreferencesV1
  runtimeOnboardingCompleted?: boolean
}

/** Load result retaining recoverable warnings for the Settings UI. */
export interface DesktopPreferencesLoadResult {
  preferences: DesktopPreferencesV1
  warning?: DesktopNetworkPreferenceWarning
  dirty: boolean
}

/** Defaults applied only when a field has no valid persisted value. */
export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferencesV1 = {
  version: DESKTOP_PREFERENCES_VERSION,
  updateChannel: DEFAULT_UPDATE_CHANNEL,
  network: {
    mode: 'default',
    proxyAgentTraffic: false,
    tests: DEFAULT_NETWORK_TEST_SETTINGS,
  },
}

/** Versioned read-modify-write owner for Desktop preferences. */
export class DesktopPreferencesStore {
  readonly path: string

  /** @param userDataPath - Electron user-data directory. */
  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'desktop-preferences.json')
  }

  /** @returns validated preferences plus any recoverable load warning. */
  load(): DesktopPreferencesLoadResult {
    return loadDesktopPreferencesFromPath(this.path)
  }

  /**
   * Atomically merge a partial root update into the latest readable state.
   * @param patch - Root fields to replace; nested Network updates use {@link updateNetwork}.
   * @returns the committed preference document.
   */
  async update(patch: Partial<Pick<DesktopPreferencesV1, 'updateChannel' | 'network' | 'runtimeOnboardingCompleted'>>): Promise<DesktopPreferencesV1> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    return await withDesktopFileWriter(this.path, async () => {
      const current = this.load().preferences
      const next = validateCompletePreferences({ ...current, ...patch })
      await this.write(next)
      return next
    })
  }

  /**
   * Atomically merge Network fields without replacing unrelated preferences.
   * @param patch - Network fields to replace.
   * @returns the committed preference document.
   */
  async updateNetwork(patch: Partial<DesktopNetworkPreferencesV1>): Promise<DesktopPreferencesV1> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    return await withDesktopFileWriter(this.path, async () => {
      const current = this.load().preferences
      const next = validateCompletePreferences({
        ...current,
        network: { ...current.network, ...patch },
      })
      await this.write(next)
      return next
    })
  }

  /**
   * Replace the complete document after validating it.
   * @param next - Complete next preferences.
   */
  async replace(next: DesktopPreferencesV1): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    await withDesktopFileWriter(this.path, async () => {
      await this.write(validateCompletePreferences(next))
    })
  }

  private async write(next: DesktopPreferencesV1): Promise<void> {
    await writeDesktopFileAtomic(this.path, `${JSON.stringify(next, undefined, 2)}\n`)
  }
}

/**
 * Load and migrate the complete Desktop preferences document.
 * @param userDataPath - Electron user-data directory.
 * @returns validated preferences plus warning and migration state.
 */
export function loadDesktopPreferences(userDataPath: string): DesktopPreferencesLoadResult {
  return loadDesktopPreferencesFromPath(join(userDataPath, 'desktop-preferences.json'))
}

/**
 * Load the desktop-owned update preference without affecting Harness state.
 * @param userDataPath - Electron user-data directory.
 * @returns stored channel, or the prerelease default when absent or invalid.
 */
export function loadUpdateChannel(userDataPath: string): UpdateChannel {
  return loadDesktopPreferences(userDataPath).preferences.updateChannel
}

/**
 * Persist only the update channel while retaining Network preferences.
 * @param userDataPath - Electron user-data directory.
 * @param updateChannel - Selected update stream.
 */
export async function saveUpdateChannel(userDataPath: string, updateChannel: UpdateChannel): Promise<void> {
  await new DesktopPreferencesStore(userDataPath).update({ updateChannel })
}

function loadDesktopPreferencesFromPath(path: string): DesktopPreferencesLoadResult {
  if (!existsSync(path)) return { preferences: cloneDefaults(), dirty: false }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    console.error('Unable to read desktop preferences', error)
    return {
      preferences: cloneDefaults(),
      warning: { code: 'unreadable', message: 'Desktop preferences could not be read; Network mode is Default.' },
      dirty: true,
    }
  }
  if (!isRecord(value)) {
    return {
      preferences: cloneDefaults(),
      warning: { code: 'invalid-root', message: 'Desktop preferences are invalid; Network mode is Default.' },
      dirty: true,
    }
  }
  if (value.version === undefined && isUpdateChannel(value.updateChannel)) {
    return { preferences: { ...cloneDefaults(), updateChannel: value.updateChannel }, dirty: true }
  }
  if (value.version !== DESKTOP_PREFERENCES_VERSION) {
    return {
      preferences: { ...cloneDefaults(), ...(isUpdateChannel(value.updateChannel) ? { updateChannel: value.updateChannel } : {}) },
      warning: { code: 'unsupported-version', message: 'Desktop preferences use an unsupported version; Network mode is Default.' },
      dirty: true,
    }
  }
  const updateChannel = isUpdateChannel(value.updateChannel) ? value.updateChannel : DEFAULT_UPDATE_CHANNEL
  const network = parseNetworkPreferences(value.network)
  if (network === undefined) {
    return {
      preferences: { ...cloneDefaults(), updateChannel, runtimeOnboardingCompleted: value.runtimeOnboardingCompleted === true },
      warning: { code: 'invalid-network', message: 'Network preferences are invalid; Network mode is Default.' },
      dirty: true,
    }
  }
  return {
    preferences: {
      version: DESKTOP_PREFERENCES_VERSION, updateChannel, network, runtimeOnboardingCompleted: value.runtimeOnboardingCompleted === true,
    },
    dirty: !isUpdateChannel(value.updateChannel),
  }
}

function parseNetworkPreferences(value: unknown): DesktopNetworkPreferencesV1 | undefined {
  if (!isRecord(value) || !isNetworkMode(value.mode) || typeof value.proxyAgentTraffic !== 'boolean') return undefined
  const manual = value.manual === undefined ? undefined : parsePersistedManualProxy(value.manual)
  if (value.manual !== undefined && manual === undefined) return undefined
  if (value.mode === 'manual' && manual === undefined) return undefined
  const tests = parseTestSettings(value.tests)
  if (tests === undefined) return undefined
  return {
    mode: value.mode,
    ...(manual === undefined ? {} : { manual }),
    proxyAgentTraffic: value.mode === 'system' || value.mode === 'manual' ? value.proxyAgentTraffic : false,
    tests,
  }
}

function parseTestSettings(value: unknown): DesktopNetworkTestSettings | undefined {
  if (!isRecord(value) || typeof value.internet204Url !== 'string' || typeof value.githubUrl !== 'string') return undefined
  try {
    const internet204Url = normalizeHttpUrl(value.internet204Url, 'Internet test URL')
    const githubUrl = normalizeHttpUrl(value.githubUrl, 'GitHub test URL')
    const llm = value.llm
    if (llm !== undefined && !isRecord(llm)) return undefined
    const providerId = isRecord(llm) && typeof llm.providerId === 'string' && llm.providerId.trim() !== ''
      ? llm.providerId.trim()
      : undefined
    const healthUrl = isRecord(llm) && typeof llm.healthUrl === 'string' && llm.healthUrl.trim() !== ''
      ? normalizeHttpUrl(llm.healthUrl, 'LLM health URL')
      : undefined
    return {
      internet204Url,
      githubUrl,
      ...(providerId === undefined && healthUrl === undefined
        ? {}
        : { llm: { ...(providerId === undefined ? {} : { providerId }), ...(healthUrl === undefined ? {} : { healthUrl }) } }),
    }
  } catch {
    return undefined
  }
}

function validateCompletePreferences(value: DesktopPreferencesV1): DesktopPreferencesV1 {
  if (!isUpdateChannel(value.updateChannel)) throw new Error('desktop preferences: invalid update channel')
  const network = parseNetworkPreferences(value.network)
  if (network === undefined) throw new Error('desktop preferences: invalid Network preferences')
  return {
    version: DESKTOP_PREFERENCES_VERSION, updateChannel: value.updateChannel, network,
    runtimeOnboardingCompleted: value.runtimeOnboardingCompleted === true,
  }
}

function cloneDefaults(): DesktopPreferencesV1 {
  return {
    ...DEFAULT_DESKTOP_PREFERENCES,
    network: { ...DEFAULT_DESKTOP_PREFERENCES.network, tests: { ...DEFAULT_NETWORK_TEST_SETTINGS } },
  }
}

function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === 'prerelease' || value === 'stable'
}

function isNetworkMode(value: unknown): value is DesktopNetworkMode {
  return value === 'default' || value === 'direct' || value === 'system' || value === 'manual'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
