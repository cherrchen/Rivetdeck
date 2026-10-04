/** Persisted selectors identify immutable user-data generations, never bundled or system runtimes. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeName } from './domain.ts'

/** Committed installation receipt. Retired generations are cleaned only before Host startup. */
export interface RuntimeReceipt {
  version: string
  generation: string
  sha256: string
  pendingRemoval: boolean
  retired: Array<{ version: string; generation: string }>
}
/** An installation destination retained until its active selector is committed. */
export interface PendingRuntimeInstallation {
  version: string
  generation: string
  target: string
}
function generation(value: unknown): value is { version: string; generation: string } {
  return value !== null && typeof value === 'object' && 'version' in value && 'generation' in value
    && typeof value.version === 'string' && /^\d+\.\d+\.\d+$/u.test(value.version)
    && typeof value.generation === 'string' && /^[a-f0-9-]{36}$/u.test(value.generation)
}
/** Read a validated interrupted destination before deleting managed files.
 * @param root Managed runtime user-data directory.
 * @param name Runtime selector.
 * @returns Pending installation, or undefined when no operation was interrupted.
 * @throws If the pending file is unreadable or its destination fields are invalid.
 */
export function readPendingRuntimeInstallation(root: string, name: RuntimeName): PendingRuntimeInstallation | undefined {
  const file = join(root, name, 'installation.pending')
  if (!existsSync(file)) return undefined
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!generation(value) || !('target' in value) || typeof value.target !== 'string'
    || !/^(darwin|linux|win32)-(x64|arm64)$/u.test(value.target)) {
    throw new Error('desktop runtime: invalid pending installation')
  }
  return { version: value.version, generation: value.generation, target: value.target }
}
/** Read and validate a durable selector before using any of its filesystem paths.
 * @param root Managed runtime user-data directory.
 * @param name Runtime selector.
 * @returns Receipt, or undefined for an uninstalled runtime.
 */
export function readRuntimeReceipt(root: string, name: RuntimeName): RuntimeReceipt | undefined {
  const file = join(root, name, 'active.json')
  if (!existsSync(file)) return undefined
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!generation(value) || !('sha256' in value) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || !('pendingRemoval' in value) || typeof value.pendingRemoval !== 'boolean'
    || !('retired' in value) || !Array.isArray(value.retired) || !value.retired.every(generation)) {
    throw new Error('desktop runtime: invalid installation receipt')
  }
  return {
    version: value.version, generation: value.generation, sha256: value.sha256,
    pendingRemoval: value.pendingRemoval, retired: value.retired,
  }
}
/** Resolve only a validated generation below managed storage.
 * @param root User-data managed root.
 * @param name Runtime selector.
 * @param target Platform and architecture.
 * @param receipt Validated receipt or generation.
 * @returns Immutable interpreter directory.
 */
export function receiptLocation(root: string, name: RuntimeName, target: string, receipt: Pick<RuntimeReceipt, 'version' | 'generation'>): string {
  return join(root, name, receipt.version, target, receipt.generation)
}
