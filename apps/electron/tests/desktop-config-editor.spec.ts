/** Desktop profile writes retain configuration transactions while package writers hold the lock. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import Settings from '@deepseek-ai/dsh-settings'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { DesktopConfigEditor } from '../src/desktop-config-editor.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

async function fixture(lockWaitMs?: number, overlayCount?: number) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-config-editor-')))
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:desktop-config-editor', ...lockWaitMs === undefined ? {} : { config: { lockWaitMs } } },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'probe', name: 'cordis:probe', config: { count: 2, title: 'initial' } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: overlayCount === undefined ? [] : [{ id: 'probe', config: { count: overlayCount } }], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    Object.assign(ctx.loader.builtins, {
      'desktop-config-editor': DesktopConfigEditor,
      settings: Settings,
      probe: {
        Config: z.object({ count: z.number().min(1).volatile(), title: z.string().volatile() }),
        apply() {},
      },
    })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, profile }
}

async function hold(profile: ProfileContext) {
  const acquired = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const done = withFileLock(join(profile.dir, 'package.json'), async () => {
    acquired.resolve(undefined)
    await release.promise
  })
  onTestFinished(async () => { release.resolve(undefined); await done })
  await acquired.promise
  return { release: () => { release.resolve(undefined) }, done }
}

it('waits beyond the upstream deadline and reads the package writer’s committed configuration', async () => {
  const { ctx, profile } = await fixture()
  const writer = await hold(profile)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  let retryScheduled = Promise.withResolvers<undefined>()
  const schedule = globalThis.setTimeout
  const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    const timer = schedule(callback, delay, ...args)
    retryScheduled.resolve(undefined)
    return timer
  })
  let outcome: 'saved' | 'failed' | undefined
  const edit = ctx.settings.update('probe', { count: 7 }).then(() => { outcome = 'saved' }, () => { outcome = 'failed' })
  try {
    // The lock retry timer signals completed filesystem contention checks before the clock advances.
    await retryScheduled.promise
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    retryScheduled = Promise.withResolvers<undefined>()
    vi.setSystemTime(Date.now() + 2500)
    await vi.advanceTimersToNextTimerAsync()
    await Promise.race([retryScheduled.promise, edit])
    expect(outcome).toBeUndefined()
    writeFileSync(profile.patchPath, '- id: probe\n  config:\n    count: 3\n    title: installed\n')
  } finally {
    timerSpy.mockRestore()
    writer.release()
    await writer.done
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
    await edit
  }
  expect(outcome).toBe('saved')
  expect(ctx.settings.describe().find(row => row.ns === 'probe')?.value).toEqual({ count: 7, title: 'installed' })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('title: installed')
})

it('leaves the patch unchanged when the configured acquisition deadline expires', async () => {
  const { ctx, profile } = await fixture(0)
  const before = readFileSync(profile.patchPath, 'utf8')
  const writer = await hold(profile)
  try {
    await expect(ctx.settings.update('probe', { count: 7 })).rejects.toThrow('timed out waiting for the writer lock')
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  } finally { writer.release(); await writer.done }
})

it('resets inherited values without deleting another row’s patch', async () => {
  const { ctx, profile } = await fixture()
  writeFileSync(profile.patchPath, '- id: config-editor\n  config:\n    lockWaitMs: 5000\n- id: probe\n  config:\n    count: 8\n    title: changed\n')
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'probe')!
  await ctx.configEditor.edit(entry, (_current, inherited) => inherited)
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('lockWaitMs: 5000')
  expect(readFileSync(profile.patchPath, 'utf8')).not.toContain('id: probe')
})

it('rejects invalid configuration before changing the document', async () => {
  const { ctx, profile } = await fixture()
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.settings.update('probe', { count: -1 })).rejects.toThrow()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
})

it('restores the previous document and Loader values after application fails', async () => {
  const { ctx, profile } = await fixture()
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'probe')!
  const before = readFileSync(profile.patchPath, 'utf8')
  const include = ctx.loader.resolve('include')
  const update = include.update.bind(include)
  vi.spyOn(include, 'update').mockImplementationOnce(update).mockRejectedValueOnce(new Error('apply failed'))
  await expect(ctx.configEditor.edit(entry, current => ({ ...current, count: 7 }))).rejects.toThrow('apply failed')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(entry.options.config).toEqual({ count: 2, title: 'initial' })
})

it('rejects negative and fractional deadlines and accepts immediate acquisition', () => {
  expect(() => DesktopConfigEditor.Config({ lockWaitMs: -1 })).toThrow()
  expect(() => DesktopConfigEditor.Config({ lockWaitMs: 1.5 })).toThrow()
  expect(DesktopConfigEditor.Config({ lockWaitMs: 0 })).toEqual({ lockWaitMs: 0 })
  expect(DesktopConfigEditor.Config({})).toEqual({ lockWaitMs: 120000 })
})

it('retains YAML comments and expressions when editing another live field', async () => {
  const { ctx, profile } = await fixture()
  writeFileSync(profile.patchPath, '# User configuration\n- id: probe\n  config:\n    title: !!js "\'expression-value\'"\n    count: 3\n')
  await ctx.settings.update('probe', { count: 4 })
  const saved = readFileSync(profile.patchPath, 'utf8')
  expect(saved).toContain('# User configuration')
  expect(saved).toContain('!!js')
  expect(saved).toContain('expression-value')
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'probe')!
  const live = entry.fiber!.config as { count: Volatile<number>; title: Volatile<string> }
  expect({ count: live.count.get(), title: live.title.get() }).toEqual({ count: 4, title: 'expression-value' })
})

it('refuses edits overridden by a Host overlay without changing the profile patch', async () => {
  const { ctx, profile } = await fixture(undefined, 5)
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.settings.update('probe', { count: 7 })).rejects.toThrow('overridden')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(ctx.settings.describe().find(row => row.ns === 'probe')?.value.count).toBe(5)
})
