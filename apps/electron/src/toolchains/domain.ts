/** Independently installed Agent runtimes; Core executors never enter this descriptor. */
export interface DesktopToolchainExecutable {
  executable: string
  version: string
  binDirectory: string
}

/** Verified startup snapshot. Changes become available after Host restart. */
export interface DesktopToolchains {
  node?: DesktopToolchainExecutable & { npmCli: string; npxCli: string }
  python?: DesktopToolchainExecutable
}

/** Main-owned fallback descriptor consumed by the Desktop subprocess provider. */
export interface DesktopToolchainPolicy {
  version: 2
  mode: 'fallback'
  basePath: string
  node?: DesktopToolchainExecutable
  python?: DesktopToolchainExecutable
  shimDirectory: string
  pythonUserBase: string
  nodeGlobalBinDirectory: string
  pythonUserBinDirectory: string
}

/** Runtime names accepted across the closed IPC API. */
export type RuntimeName = 'node' | 'python'
/** Main lifecycle phases shared by onboarding and Settings. */
export type RuntimePhase = 'not-installed' | 'downloading' | 'verifying' | 'installing' | 'installed' | 'update-available' | 'removing' | 'failed'
/** Sanitized installation failures translated by the client. */
export type RuntimeError = 'download' | 'checksum' | 'archive' | 'verification' | 'disk' | 'interrupted' | 'corrupt' | 'operation'
/** One runtime's state; location always belongs to userData. */
export interface RuntimeState {
  name: RuntimeName
  version: string
  phase: RuntimePhase
  installedVersion?: string | undefined
  location?: string | undefined
  received?: number | undefined
  total?: number | undefined
  error?: RuntimeError | undefined
  restartRequired: boolean
}
/** Main snapshot with onboarding independent from installation. */
export interface RuntimeSnapshot {
  onboardingCompleted: boolean
  node: RuntimeState
  python: RuntimeState
}
/** Typed privileged runtime operations; subscriptions return a disposer. */
export interface RuntimeCapability {
  getState(): Promise<RuntimeSnapshot>
  install(name: RuntimeName): Promise<void>
  cancel(name: RuntimeName): Promise<void>
  remove(name: RuntimeName): Promise<void>
  completeOnboarding(): Promise<void>
  subscribe(callback: (snapshot: RuntimeSnapshot) => void): () => void
}
/** Validate runtime selectors at the renderer IPC boundary.
 * @param value Untrusted IPC argument.
 * @returns Closed runtime name.
 */
export function requireRuntimeName(value: unknown): RuntimeName {
  if (value !== 'node' && value !== 'python') throw new Error('desktop runtimes: invalid runtime name')
  return value
}
