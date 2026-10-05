import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DESKTOP_PREFERENCES,
  DEFAULT_UPDATE_CHANNEL,
  DesktopPreferencesStore,
  loadDesktopPreferences,
  loadUpdateChannel,
  saveUpdateChannel,
} from '../src/preferences.ts'

describe('Electron desktop preferences', () => {
  it('defaults new users without materializing a file', async () => {
    const root = await temporaryRoot()
    expect(loadUpdateChannel(root)).toBe(DEFAULT_UPDATE_CHANNEL)
    expect(loadDesktopPreferences(root)).toEqual({ preferences: DEFAULT_DESKTOP_PREFERENCES, dirty: false })
  })

  it('migrates the legacy update-only document and retains the channel on save', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'desktop-preferences.json'), '{"updateChannel":"stable"}\n')
    const loaded = loadDesktopPreferences(root)
    expect(loaded.dirty).toBe(true)
    expect(loaded.preferences.updateChannel).toBe('stable')
    expect(loaded.preferences.network.mode).toBe('default')
    await new DesktopPreferencesStore(root).updateNetwork({ mode: 'direct' })
    expect(await stored(root)).toMatchObject({ version: 1, updateChannel: 'stable', network: { mode: 'direct' } })
  })

  it('updates channel and Network fields without overwriting each other', async () => {
    const root = await temporaryRoot()
    const store = new DesktopPreferencesStore(root)
    await store.updateNetwork({
      mode: 'manual',
      manual: { protocol: 'http', host: '127.0.0.1', port: 7890 },
    })
    await saveUpdateChannel(root, 'stable')
    expect(store.load().preferences).toMatchObject({
      updateChannel: 'stable',
      network: { mode: 'manual', manual: { host: '127.0.0.1', port: 7890 } },
    })
    await store.updateNetwork({ mode: 'system' })
    expect(loadUpdateChannel(root)).toBe('stable')
  })

  it('serializes concurrent root and Network writers around a fresh read', async () => {
    const root = await temporaryRoot()
    const one = new DesktopPreferencesStore(root)
    const two = new DesktopPreferencesStore(root)
    await Promise.all([
      one.update({ updateChannel: 'stable' }),
      two.updateNetwork({ mode: 'direct' }),
    ])
    expect(one.load().preferences).toMatchObject({ updateChannel: 'stable', network: { mode: 'direct' } })
  })

  it('falls back only the invalid Network section and exposes a warning', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'desktop-preferences.json'), JSON.stringify({
      version: 1,
      updateChannel: 'stable',
      network: {
        mode: 'manual',
        manual: { protocol: 'http', host: 'proxy.example', port: 'abc' },
        proxyAgentTraffic: false,
        tests: { internet204Url: 'https://example.test/204', githubUrl: 'https://github.com/' },
      },
    }))
    const loaded = loadDesktopPreferences(root)
    expect(loaded.preferences.updateChannel).toBe('stable')
    expect(loaded.preferences.network.mode).toBe('default')
    expect(loaded.warning?.code).toBe('invalid-network')
  })

  it('recovers from corrupt JSON without preventing startup', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'desktop-preferences.json'), '{')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loaded = loadDesktopPreferences(root)
    expect(loaded.preferences).toEqual(DEFAULT_DESKTOP_PREFERENCES)
    expect(loaded.warning?.code).toBe('unreadable')
    error.mockRestore()
  })
})

async function temporaryRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-electron-preferences-'))
}

async function stored(root: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, 'desktop-preferences.json'), 'utf8'))
}

describe('runtime onboarding preferences', () => {
  it('prompts fresh and existing users once, and preserves Skip across other settings updates', async () => {
    const root = await temporaryRoot()
    const store = new DesktopPreferencesStore(root)
    expect(store.load().preferences.runtimeOnboardingCompleted).not.toBe(true)
    await writeFile(store.path, JSON.stringify(DEFAULT_DESKTOP_PREFERENCES))
    expect(store.load().preferences.runtimeOnboardingCompleted).toBe(false)
    await store.update({ runtimeOnboardingCompleted: true })
    await store.updateNetwork({ mode: 'direct' })
    await saveUpdateChannel(root, 'stable')
    expect(new DesktopPreferencesStore(root).load().preferences.runtimeOnboardingCompleted).toBe(true)
  })
})
