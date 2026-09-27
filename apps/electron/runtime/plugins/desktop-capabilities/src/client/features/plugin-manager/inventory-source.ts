/** Observable Host inventory plus Client fiber phases for Capabilities rows. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { TRACKED_COMPONENTS } from './roster.ts'
import {
  phaseFromFiberState, runtimeFromInventory, sameRuntimeMap,
  type ComponentPhase, type ComponentRuntime, type ComponentRuntimeMap,
} from './runtime.ts'

/** One Host inventory row used to resolve Loader-backed Capabilities components. */
export type InventoryEntry = {
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: ComponentPhase
}

/** Snapshot source the section's `useRuntimes` hook binds. */
export type RuntimesSource = ObservableSnapshot<ComponentRuntimeMap | null> & {
  /** Replace the snapshot when the map actually changed. */
  set(next: ComponentRuntimeMap | null): void
}

/**
 * Create a runtimes snapshot that starts unread and is filled by `watchComponentRuntimes`.
 * @returns the source object; callers own refresh and disposal of listeners.
 */
export function createRuntimesSource(): RuntimesSource {
  let snapshot: ComponentRuntimeMap | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set(next) {
      if (sameRuntimeMap(snapshot, next)) return
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

/**
 * Fold Host inventory rows and Client feature fibers into one roster map.
 * Absent inventory matches and missing fibers are omitted rather than invented.
 * @param ctx - feature fiber whose registry holds sibling Client features.
 * @param entries - latest successful `pluginInventory/list` rows; empty when none yet.
 * @returns runtime per observed roster component id.
 */
export function buildComponentRuntimes(ctx: ClientContext, entries: readonly InventoryEntry[]): ComponentRuntimeMap {
  const map: Record<string, ComponentRuntime> = {}
  for (const component of TRACKED_COMPONENTS) {
    const source = component.source
    if (source.kind === 'inventory') {
      const runtime = runtimeFromInventory(entries, source.moduleName)
      if (runtime !== undefined) map[component.id] = runtime
      continue
    }
    const fiber = fiberNamed(ctx, source.fiberName)
    if (fiber === undefined) continue
    map[component.id] = {
      enabled: true,
      phase: phaseFromFiberState(fiber.state),
    }
  }
  return map
}

/**
 * Read Host plugin inventory and Client feature fibers into one roster map.
 * @param ctx - feature fiber with `remote.pluginInventory` and the registry.
 * @returns runtime per observed roster component id.
 */
export async function readComponentRuntimes(ctx: ClientContext): Promise<ComponentRuntimeMap> {
  const entries = await listInventoryEntries(ctx)
  return buildComponentRuntimes(ctx, entries ?? [])
}

/**
 * Keep the runtimes snapshot current on Host plugin changes, reconnect, and fiber status.
 * Host `pluginInventory/list` runs on start, `plugin-manager/changed`, and reconnect.
 * Client fiber phases refresh from `internal/status` without a new Host round-trip.
 * @param ctx - feature fiber.
 * @param source - snapshot to update.
 * @returns disposer for the listeners.
 */
export function watchComponentRuntimes(ctx: ClientContext, source: RuntimesSource): () => void {
  let closed = false
  let requested = 0
  let entries: readonly InventoryEntry[] = []
  const publish = (): void => {
    if (!closed) source.set(buildComponentRuntimes(ctx, entries))
  }
  const refreshInventory = (): void => {
    const request = ++requested
    void listInventoryEntries(ctx).then((next) => {
      if (closed || request !== requested) return
      if (next !== undefined) entries = next
      publish()
    })
  }
  publish()
  refreshInventory()
  const disposers = [
    ctx.remote.$on('plugin-manager/changed', refreshInventory),
    ctx.on('connection/reset', refreshInventory),
    ctx.on('internal/status', publish, { global: true }),
  ]
  return () => {
    closed = true
    for (const dispose of disposers) dispose()
  }
}

async function listInventoryEntries(ctx: ClientContext): Promise<readonly InventoryEntry[] | undefined> {
  try {
    return await readListedEntries(ctx)
  } catch (error) {
    // Display-only: a thrown Host read leaves Loader-backed rows unread rather than inventing a phase.
    void error
    return undefined
  }
}

async function readListedEntries(ctx: ClientContext): Promise<readonly InventoryEntry[] | undefined> {
  const result = await ctx.remote.pluginInventory.list()
  if (!result.ok) return undefined
  return result.value.entries
}

function fiberNamed(ctx: ClientContext, name: string): { readonly state: number } | undefined {
  for (const runtime of ctx.registry.values()) {
    if (runtime.name !== name) continue
    for (const fiber of runtime.fibers) return fiber
  }
  return undefined
}
