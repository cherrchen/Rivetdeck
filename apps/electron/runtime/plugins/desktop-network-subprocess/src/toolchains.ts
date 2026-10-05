import { isAbsolute, posix, win32 } from 'node:path'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

interface ExecutablePolicy { executable: string; binDirectory: string; version: string }

/** Serialized Main-owned fallback locations accepted by the Host provider. */
export interface ToolchainPolicy {
  version: 2
  mode: 'fallback'
  basePath: string
  node?: ExecutablePolicy
  python?: ExecutablePolicy
  shimDirectory: string
  pythonUserBase: string
  nodeGlobalBinDirectory: string
  pythonUserBinDirectory: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === keys.sort().join(',')
}

function executable(value: unknown): value is ExecutablePolicy {
  return record(value) && exactKeys(value, ['executable', 'binDirectory', 'version'])
    && typeof value.executable === 'string' && isAbsolute(value.executable)
    && typeof value.binDirectory === 'string' && isAbsolute(value.binDirectory)
    && typeof value.version === 'string' && /^\d+\.\d+\.\d+$/u.test(value.version)
}

/** Reject malformed Host descriptors before any Agent process starts. */
export function parseToolchainPolicy(serialized: string | undefined): ToolchainPolicy | undefined {
  if (serialized === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(serialized) } catch { throw new Error('desktop toolchains: invalid policy JSON') }
  if (!record(value) || !exactKeys(value, ['version', 'mode', 'basePath', ...(value.node === undefined ? [] : ['node']), ...(value.python === undefined ? [] : ['python']), 'shimDirectory', 'pythonUserBase', 'nodeGlobalBinDirectory', 'pythonUserBinDirectory'])
    || value.version !== 2 || value.mode !== 'fallback' || typeof value.basePath !== 'string'
    || (value.node !== undefined && !executable(value.node)) || (value.python !== undefined && !executable(value.python))
    || typeof value.shimDirectory !== 'string' || !isAbsolute(value.shimDirectory)
    || typeof value.pythonUserBase !== 'string' || !isAbsolute(value.pythonUserBase)
    || typeof value.nodeGlobalBinDirectory !== 'string' || !isAbsolute(value.nodeGlobalBinDirectory)
    || typeof value.pythonUserBinDirectory !== 'string' || !isAbsolute(value.pythonUserBinDirectory)) {
    throw new Error('desktop toolchains: invalid policy')
  }
  return {
    version: 2, mode: 'fallback', basePath: value.basePath,
    ...(value.node === undefined ? {} : { node: value.node }), ...(value.python === undefined ? {} : { python: value.python }),
    shimDirectory: value.shimDirectory, pythonUserBase: value.pythonUserBase,
    nodeGlobalBinDirectory: value.nodeGlobalBinDirectory, pythonUserBinDirectory: value.pythonUserBinDirectory,
  }
}

function pathEntry(env: Readonly<NodeJS.ProcessEnv> | undefined, platform: NodeJS.Platform): [string, string | undefined] | undefined {
  return Object.entries(env ?? {}).filter(([key]) => platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH').at(-1)
}

/**
 * Apply project and request PATH ahead of Desktop fallback entries, preserving explicit tombstones.
 * PATH entries join with `:` or `;` for `platform`.
 */
export function toolchainOverrides(
  explicit: Readonly<NodeJS.ProcessEnv> | undefined,
  policy: ToolchainPolicy,
  launch: LaunchEnvironmentSnapshot,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...explicit }
  const requested = pathEntry(explicit, platform)
  if (platform === 'win32') {
    for (const key of Object.keys(result)) if (key.toUpperCase() === 'PATH') delete result[key]
  }
  const layerPath = (source: 'project-env' | 'user-env'): string | undefined => ['PATH', 'Path', 'path']
    .map(name => launch.getFrom(name, [source])?.value)
    .find(value => value !== undefined)
  const key = requested?.[0] ?? 'PATH'
  result[key] = requested !== undefined && requested[1] === undefined ? undefined : [
    requested?.[1], layerPath('project-env'), layerPath('user-env'), policy.basePath,
    policy.node !== undefined || policy.python !== undefined ? policy.shimDirectory : undefined,
    policy.node === undefined ? undefined : policy.nodeGlobalBinDirectory,
    policy.python === undefined ? undefined : policy.pythonUserBinDirectory,
    policy.node?.binDirectory, policy.python?.binDirectory,
  ]
    .filter(Boolean).join(platform === 'win32' ? win32.delimiter : posix.delimiter)
  if (!Object.keys(result).some(name => platform === 'win32' ? name.toUpperCase() === 'PYTHONUSERBASE' : name === 'PYTHONUSERBASE')) {
    const declared = launch.getFrom('PYTHONUSERBASE', ['project-env', 'user-env'])?.value
    if (declared !== undefined) result.PYTHONUSERBASE = declared
  }
  return result
}
