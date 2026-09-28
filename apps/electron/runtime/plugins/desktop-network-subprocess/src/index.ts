import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { parseToolchainPolicy, toolchainOverrides, type ToolchainPolicy } from './toolchains.ts'

const KEYS = [
  'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY',
] as const

interface AgentProxyPolicy {
  force: boolean
  values: NodeJS.ProcessEnv
}

/** Desktop Host provider that applies Agent proxy policy at the shared subprocess seam. */
export class DesktopNetworkSubprocessRuntime extends LocalSubprocessRuntime {
  private readonly policy: AgentProxyPolicy | undefined
  private readonly toolchainPolicy: ToolchainPolicy | undefined
  private readonly launch: LaunchEnvironmentSnapshot

  constructor(ctx: Context) {
    super(ctx)
    this.launch = launchEnvironmentOf(ctx)
    const policy = parsePolicy(process.env.DSH_ELECTRON_AGENT_PROXY_POLICY)
    if (policy !== undefined && !policy.force) {
      // The Host's inherited proxy names point at the Gateway; only Main's original values
      // and the CLI's discovered file layers can supply the Agent's opt-out environment.
      fillAgentProxyValues(policy.values, this.launch, process.platform)
    }
    this.policy = policy
    this.toolchainPolicy = parseToolchainPolicy(process.env.DSH_ELECTRON_TOOLCHAIN_POLICY)
  }

  override resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    // The local provider's childEnv accepts tombstones although these two public signatures omit them.
    return super.resolveExecutable(command, this.childOverrides(env) as Record<string, string>, signal)
  }

  override spawn(spec: SubprocessSpawnSpec) {
    return super.spawn({ ...spec, env: this.childOverrides(spec.env) })
  }

  override spawnTerminal(spec: SubprocessTerminalSpawnSpec) {
    return super.spawnTerminal({ ...spec, env: this.childOverrides(spec.env) as Record<string, string> })
  }

  private childOverrides(explicit?: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv | undefined {
    const proxy = this.policy === undefined ? explicit === undefined ? undefined : { ...explicit } : this.policy.force
      ? { ...explicit, ...this.policy.values }
      : { ...this.policy.values, ...explicit }
    return this.toolchainPolicy === undefined ? proxy : toolchainOverrides(proxy, this.toolchainPolicy, this.launch, process.platform)
  }
}

/**
 * Supply the proxy names a non-forcing Agent policy leaves unset from the launch environment layers.
 * A name the policy sets is a value the Agent must keep, so every spelling of that variable takes it:
 * a value filled into one spelling would otherwise reach the same Windows variable as the policy's own.
 * @param values - the policy's proxy overrides, updated in place; `undefined` marks a name to remove.
 * @param launch - the launch environment snapshot to read `project-env` and `user-env` from.
 * @param platform - the platform whose environment names decide which spellings denote one variable.
 */
export function fillAgentProxyValues(
  values: NodeJS.ProcessEnv,
  launch: LaunchEnvironmentSnapshot,
  platform: NodeJS.Platform,
): void {
  for (const { name, spellings } of PROXY_VARIABLES[platform === 'win32' ? 'win32' : 'posix']) {
    const declared = spellings.map(key => values[key]).find(value => value !== undefined)
    const value = declared ?? launch.getFrom(name, ['project-env', 'user-env'])?.value
    for (const key of spellings) values[key] = value
  }
}

/** One variable the Agent proxy policy controls, with every spelling of its name. */
interface ProxyVariable {
  /** the name the launch environment resolves, folded where the platform folds names. */
  name: string
  /** the policy keys that denote this variable. */
  spellings: readonly string[]
}

/** Policy names grouped per variable, keyed by the platform's folding rule. */
const PROXY_VARIABLES: Record<'win32' | 'posix', readonly ProxyVariable[]> = {
  win32: proxyVariables(key => key.toUpperCase()),
  posix: proxyVariables(key => key),
}

/**
 * Group the policy's proxy names by the environment variable each denotes.
 * @param fold - maps a spelling to the name its platform resolves.
 * @returns one entry per variable, in `KEYS` order.
 */
function proxyVariables(fold: (key: string) => string): readonly ProxyVariable[] {
  const byName: Record<string, string[]> = {}
  for (const key of KEYS) {
    const name = fold(key)
    const spellings = byName[name]
    if (spellings === undefined) byName[name] = [key]
    else spellings.push(key)
  }
  return Object.entries(byName).map(([name, spellings]) => ({ name, spellings }))
}

function parsePolicy(serialized: string | undefined): AgentProxyPolicy | undefined {
  if (serialized === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(serialized) } catch { throw new Error('desktop network: invalid Agent proxy policy') }
  if (typeof parsed !== 'object' || parsed === null || !('force' in parsed) || typeof parsed.force !== 'boolean'
    || !('values' in parsed) || typeof parsed.values !== 'object' || parsed.values === null) {
    throw new Error('desktop network: invalid Agent proxy policy')
  }
  const values = parsed.values as Record<string, unknown>
  if (Object.keys(values).length !== KEYS.length || KEYS.some(key => !(key in values) || (values[key] !== null && typeof values[key] !== 'string'))) {
    throw new Error('desktop network: invalid Agent proxy policy')
  }
  const proxyValues: NodeJS.ProcessEnv = {}
  for (const key of KEYS) proxyValues[key] = values[key] === null ? undefined : values[key] as string
  return { force: parsed.force, values: proxyValues }
}

export default DesktopNetworkSubprocessRuntime
