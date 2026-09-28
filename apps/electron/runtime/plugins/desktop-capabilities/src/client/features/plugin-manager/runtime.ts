/** Live runtime of one Capabilities product component: Host inventory or Client fiber. */

/** Fiber phase as `pluginInventory/list` reports it. */
export type ComponentPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** Enablement and fiber phase for one roster row. */
export interface ComponentRuntime {
  /** Effective enablement: Loader enablement, or true while a Client fiber exists. */
  readonly enabled: boolean
  /** Root-fiber phase; null when no live fiber exists. */
  readonly phase: ComponentPhase
}

/** Roster id to live runtime. Null until the first inventory read finishes. */
export type ComponentRuntimeMap = Readonly<Record<string, ComponentRuntime>>

/** Cordis FiberState numeric mirror; the enum is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

/**
 * Map a Cordis fiber state number onto the public inventory phase.
 * @param state - `fiber.state` numeric value.
 * @returns the inventory phase, or null when the fiber is gone.
 */
export function phaseFromFiberState(state: number): ComponentPhase {
  switch (state) {
    case FIBER_STATE.PENDING: return 'pending'
    case FIBER_STATE.LOADING: return 'loading'
    case FIBER_STATE.ACTIVE: return 'active'
    case FIBER_STATE.FAILED: return 'failed'
    case FIBER_STATE.DISPOSED: return null
    case FIBER_STATE.UNLOADING: return 'unloading'
    default: return null
  }
}

/**
 * Pick the live Loader row for a package: the enabled entry, else the first match.
 * @param entries - Host inventory rows.
 * @param moduleName - exact Loader module specifier.
 * @returns runtime, or undefined when the package is absent.
 */
export function runtimeFromInventory(
  entries: readonly { readonly moduleName: string; readonly enabled: boolean; readonly fiberPhase: ComponentPhase }[],
  moduleName: string,
): ComponentRuntime | undefined {
  const matches = entries.filter(entry => entry.moduleName === moduleName)
  const live = matches.find(entry => entry.enabled) ?? matches[0]
  if (live === undefined) return undefined
  return { enabled: live.enabled, phase: live.fiberPhase }
}

/**
 * Count line over a pack's components: the roster total, then only observed states.
 * Unread rows are omitted from running/off/failed so a missing Host read is not Off.
 * @param total - roster length, including rows whose runtime has not been observed.
 * @param runtimes - observed runtimes; `undefined` slots are unread, not off.
 * @param t - locale translate.
 * @returns `共 N 个` plus running/off/failed counts when those states occur.
 */
export function partsSummary(
  total: number,
  runtimes: readonly (ComponentRuntime | undefined)[],
  t: (key: 'countTotal' | 'countRunning' | 'countOff' | 'countFailed', params: { count: string }) => string,
): string {
  const known = runtimes.filter((row): row is ComponentRuntime => row !== undefined)
  const failed = known.filter(row => row.phase === 'failed').length
  const off = known.filter(row => !row.enabled).length
  const running = known.filter(row => row.enabled && row.phase === 'active').length
  return [
    t('countTotal', { count: String(total) }),
    ...running > 0 ? [t('countRunning', { count: String(running) })] : [],
    ...off > 0 ? [t('countOff', { count: String(off) })] : [],
    ...failed > 0 ? [t('countFailed', { count: String(failed) })] : [],
  ].join(' · ')
}

/** Status copy key for a row: off, idle, or its fiber phase. Unread is idle, not off. */
export function rowStateKey(runtime: ComponentRuntime | undefined): 'partOff' | 'rowStateIdle' | `rowPhase${'Pending' | 'Loading' | 'Active' | 'Failed' | 'Unloading'}` {
  if (runtime === undefined) return 'rowStateIdle'
  if (!runtime.enabled) return 'partOff'
  if (runtime.phase === null) return 'rowStateIdle'
  switch (runtime.phase) {
    case 'pending': return 'rowPhasePending'
    case 'loading': return 'rowPhaseLoading'
    case 'active': return 'rowPhaseActive'
    case 'failed': return 'rowPhaseFailed'
    case 'unloading': return 'rowPhaseUnloading'
    default: {
      const _exhaustive: never = runtime.phase
      return _exhaustive
    }
  }
}

/** Dot beside a row: its fiber phase, or idle. */
export function rowDotState(runtime: ComponentRuntime | undefined): 'idle' | 'ongoing' | 'done' | 'error' {
  if (runtime === undefined || !runtime.enabled || runtime.phase === null) return 'idle'
  switch (runtime.phase) {
    case 'pending': return 'idle'
    case 'loading': return 'ongoing'
    case 'active': return 'done'
    case 'failed': return 'error'
    case 'unloading': return 'ongoing'
    default: {
      const _exhaustive: never = runtime.phase
      return _exhaustive
    }
  }
}

/** Row data-state for dimming and failure ink. Unread rows are not dimmed as off. */
export function rowDataState(runtime: ComponentRuntime | undefined): 'off' | 'failed' | undefined {
  if (runtime === undefined) return undefined
  if (!runtime.enabled) return 'off'
  if (runtime.phase === 'failed') return 'failed'
  return undefined
}

/**
 * Whether two runtime maps describe the same enablement and phases.
 * @param left - previous snapshot.
 * @param right - next snapshot.
 * @returns true when every id matches.
 */
export function sameRuntimeMap(left: ComponentRuntimeMap | null, right: ComponentRuntimeMap | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => left[key]?.enabled === right[key]?.enabled && left[key]?.phase === right[key]?.phase)
}
