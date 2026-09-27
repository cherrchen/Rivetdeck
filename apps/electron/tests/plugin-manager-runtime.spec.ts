import { Context } from '@deepseek-ai/cordis'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  buildComponentRuntimes, createRuntimesSource, readComponentRuntimes, watchComponentRuntimes,
} from '../runtime/plugins/desktop-capabilities/src/client/features/plugin-manager/inventory-source.ts'
import {
  partsSummary, phaseFromFiberState, rowDataState, rowDotState, rowStateKey, runtimeFromInventory, sameRuntimeMap,
  type ComponentRuntime,
} from '../runtime/plugins/desktop-capabilities/src/client/features/plugin-manager/runtime.ts'

const NETWORK = '@dsh-electron/dsh-electron-network-subprocess'
const BROWSE = '@deepseek-ai/dsh-host-directory-picker-browse'

function t(key: 'countTotal' | 'countRunning' | 'countOff' | 'countFailed', params: { count: string }): string {
  return `${key}:${params.count}`
}

describe('Capabilities component runtime mapping', () => {
  it('maps Cordis fiber states onto inventory phases', () => {
    expect(phaseFromFiberState(0)).toBe('pending')
    expect(phaseFromFiberState(1)).toBe('loading')
    expect(phaseFromFiberState(2)).toBe('active')
    expect(phaseFromFiberState(3)).toBe('failed')
    expect(phaseFromFiberState(4)).toBeNull()
    expect(phaseFromFiberState(5)).toBe('unloading')
    expect(phaseFromFiberState(99)).toBeNull()
  })

  it('prefers the enabled inventory row when the same module appears twice', () => {
    const entries = [
      { moduleName: NETWORK, enabled: false, fiberPhase: null },
      { moduleName: NETWORK, enabled: true, fiberPhase: 'active' as const },
    ]
    expect(runtimeFromInventory(entries, NETWORK)).toEqual({ enabled: true, phase: 'active' })
    expect(runtimeFromInventory(entries, BROWSE)).toBeUndefined()
  })

  it('counts only observed running, off, and failed states against the roster total', () => {
    const running: ComponentRuntime = { enabled: true, phase: 'active' }
    expect(partsSummary(5, [], t)).toBe('countTotal:5')
    expect(partsSummary(5, [running, running, running, running, running], t)).toBe('countTotal:5 · countRunning:5')
    expect(partsSummary(5, [running, { enabled: false, phase: null }, undefined, { enabled: true, phase: 'failed' }], t))
      .toBe('countTotal:5 · countRunning:1 · countOff:1 · countFailed:1')
  })

  it('treats unread rows as idle rather than off', () => {
    expect(rowStateKey(undefined)).toBe('rowStateIdle')
    expect(rowStateKey({ enabled: false, phase: 'active' })).toBe('partOff')
    expect(rowStateKey({ enabled: true, phase: null })).toBe('rowStateIdle')
    expect(rowStateKey({ enabled: true, phase: 'active' })).toBe('rowPhaseActive')
    expect(rowDotState(undefined)).toBe('idle')
    expect(rowDotState({ enabled: true, phase: 'active' })).toBe('done')
    expect(rowDotState({ enabled: true, phase: 'failed' })).toBe('error')
    expect(rowDataState(undefined)).toBeUndefined()
    expect(rowDataState({ enabled: false, phase: null })).toBe('off')
    expect(rowDataState({ enabled: true, phase: 'failed' })).toBe('failed')
    expect(rowDataState({ enabled: true, phase: 'active' })).toBeUndefined()
  })

  it('reports equal runtime maps only when every id matches', () => {
    const left = { brand: { enabled: true, phase: 'active' as const } }
    expect(sameRuntimeMap(left, left)).toBe(true)
    expect(sameRuntimeMap(null, left)).toBe(false)
    expect(sameRuntimeMap(left, { brand: { enabled: true, phase: 'loading' } })).toBe(false)
  })
})

describe('Capabilities component inventory source', () => {
  it('reads Loader-backed rows from pluginInventory/list and Client features from named fibers', async () => {
    const ctx = new Context()
    new TestRemote(ctx, {
      pluginInventory: {
        list: vi.fn(async () => ({
          ok: true as const,
          value: {
            entries: [
              { entryId: 'net', moduleName: NETWORK, enabled: true, fiberPhase: 'active' as const },
              { entryId: 'browse', moduleName: BROWSE, enabled: true, fiberPhase: 'active' as const },
            ],
          },
        })),
      },
    })
    await ctx.plugin({ name: 'directory-picker', apply() {} }).await()
    await ctx.plugin({ name: 'brand', apply() {} }).await()
    await ctx.plugin({ name: 'network-settings', apply() {} }).await()
    const map = await readComponentRuntimes(ctx)
    expect(map).toEqual({
      'network-subprocess': { enabled: true, phase: 'active' },
      'directory-picker-backend': { enabled: true, phase: 'active' },
      'directory-picker': { enabled: true, phase: 'active' },
      brand: { enabled: true, phase: 'active' },
      'network-settings': { enabled: true, phase: 'active' },
    })
  })

  it('omits Loader-backed rows when the Host list fails and still reports live Client fibers', async () => {
    const ctx = new Context()
    new TestRemote(ctx, {
      pluginInventory: { list: vi.fn(async () => ({ ok: false as const, error: { code: 'REMOTE_ERROR', message: 'down' } })) },
    })
    await ctx.plugin({ name: 'brand', apply() {} }).await()
    const map = await readComponentRuntimes(ctx)
    expect(map['network-subprocess']).toBeUndefined()
    expect(map.brand).toEqual({ enabled: true, phase: 'active' })
  })

  it('refreshes Host rows on plugin-manager/changed without inventing Client fibers', async () => {
    const ctx = new Context()
    const list = vi.fn(async () => ({
      ok: true as const,
      value: { entries: [{ entryId: 'net', moduleName: NETWORK, enabled: true, fiberPhase: 'active' as const }] },
    }))
    const remote = new TestRemote(ctx, { pluginInventory: { list } })
    const source = createRuntimesSource()
    const stop = watchComponentRuntimes(ctx, source)
    expect(buildComponentRuntimes(ctx, [])).toEqual({})
    await vi.waitFor(() => {
      expect(source.getSnapshot()?.['network-subprocess']).toEqual({ enabled: true, phase: 'active' })
    })
    expect(source.getSnapshot()?.brand).toBeUndefined()
    list.mockResolvedValueOnce({
      ok: true as const,
      value: { entries: [{ entryId: 'net', moduleName: NETWORK, enabled: false, fiberPhase: null }] },
    })
    remote.emit('plugin-manager/changed', [{ reason: 'bundle' }])
    await vi.waitFor(() => {
      expect(source.getSnapshot()?.['network-subprocess']).toEqual({ enabled: false, phase: null })
    })
    stop()
  })
})
