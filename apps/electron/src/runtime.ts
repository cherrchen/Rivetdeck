import { spawn, type ChildProcessByStdio, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { devNull } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

/** The bounded startup window before Electron reports a failed Harness boot. */
export const HARNESS_START_TIMEOUT_MS = 60_000

/**
 * Executable and extra environment for every dsh child the Desktop supervises.
 *
 * Windows needs a console-subsystem image: a GUI image such as `electron.exe` has no console, so
 * every console target it creates receives a new visible Windows Terminal. Launching the packaged
 * Node.js with the stdio of {@link spawnHarnessChild} gives the whole process tree one hidden
 * console to inherit.
 */
export interface HostRuntime {
  /** Executable that starts a Node.js-compatible dsh process. */
  executable: string
  /** Extra environment required by `executable`, empty for a packaged Node.js. */
  env: Record<string, string>
}

/**
 * Resolve the executable that carries the supervised Host and its plugin commands.
 *
 * Windows packaging ships `node.exe` under `resources/core-runtime`; development builds use the copy
 * created by `pnpm --filter @dsh-electron/dsh-electron prepare:core`. Other platforms keep using
 * Electron's own Node-compatible child mode, which has no console-visibility defect there.
 *
 * @param options - Application paths, packaging state, and optional executable override.
 * @param options.appPath - Electron application root.
 * @param options.resourcesPath - Electron `resources` directory beside the packaged application.
 * @param options.packaged - Whether this process runs from a packaged application.
 * @param options.platform - Target platform; defaults to the running platform.
 * @param options.arch - Target architecture; defaults to the running architecture.
 * @param options.override - Explicit Windows executable that replaces both packaged locations; a path that does not exist is an error.
 * @param options.exists - Existence probe used for candidate paths.
 * @returns Executable and environment for supervised dsh children.
 * @throws When a Windows `override` names a missing file, or a Windows target has no prepared Node.js at any candidate path.
 */
export function resolveHostRuntime(options: {
  appPath: string
  resourcesPath: string
  packaged: boolean
  platform?: NodeJS.Platform
  arch?: string
  override?: string | undefined
  exists?: (path: string) => boolean
}): HostRuntime {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { executable: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  const exists = options.exists ?? existsSync
  if (options.override !== undefined) {
    if (!exists(options.override)) {
      throw new Error(`electron runtime: DSH_ELECTRON_NODE_BINARY does not name an existing executable (${options.override})`)
    }
    return { executable: options.override, env: {} }
  }
  const arch = options.arch ?? process.arch
  const candidates = [
    options.packaged ? join(options.resourcesPath, 'core-runtime', 'node.exe') : undefined,
    join(options.appPath, '.electron-build', 'core-runtime', `win32-${arch}`, 'node.exe'),
  ].filter((candidate): candidate is string => candidate !== undefined)
  const executable = candidates.find(candidate => exists(candidate))
  if (executable === undefined) {
    throw new Error(
      `electron runtime: prepared Node.js is missing (looked for ${candidates.join(', ')}); `
      + 'run pnpm --filter @dsh-electron/dsh-electron prepare:core',
    )
  }
  return { executable, env: {} }
}

/**
 * Spawn one supervised dsh child that owns a hidden, inheritable console.
 *
 * `windowsHide` alone makes libuv pass `CREATE_NO_WINDOW`, which starts a console-subsystem child
 * with no console handle at all: the job runner
 * (`packages/subprocess/subprocess-local/src/windows-job.ts`) and every child under the restricted
 * sandbox token then allocate a new visible console, and a restricted child dies during DLL
 * initialization with `STATUS_DLL_INIT_FAILED`. libuv omits `CREATE_NO_WINDOW` when one stdio entry
 * is an inherited descriptor
 * (https://github.com/libuv/libuv/blob/v1.52.1/src/win/process.c#L1034-L1042), so handing the child
 * the stdin device descriptor keeps `windowsHide`'s `SW_HIDE` half: Windows allocates one console
 * for the child with a hidden window, and every descendant inherits it. Other platforms gain and
 * lose nothing: the descriptor reads as an exhausted stream, which is what `stdio: 'ignore'`
 * already provided.
 *
 * The device path is `os.devNull`, never the DOS alias `NUL`: `fs` resolves the path and rewrites
 * it into the `\\?\` extended-length namespace (`toNamespacedPath`), where `NUL` names a regular
 * file and Windows fails the open with `ENOENT`. `os.devNull` is `\\.\nul` on Windows — the Win32
 * device namespace that rewrite leaves alone — and `/dev/null` elsewhere.
 *
 * @param executable - Resolved Host runtime executable.
 * @param args - Arguments passed to `executable`.
 * @param options - Spawn options for cwd, environment, and signals; `stdio` and `windowsHide` are always supplied here.
 * @returns Child process with no stdin stream and piped stdout and stderr.
 */
export function spawnHarnessChild(
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessByStdio<null, Readable, Readable> {
  const stdin = openSync(devNull, 'r')
  try {
    // Node's spawn overloads infer stdio types from tuple literals only, so the descriptor in the
    // tuple forces this cast.
    return spawn(executable, args, {
      ...options,
      stdio: [stdin, 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessByStdio<null, Readable, Readable>
  } finally {
    closeSync(stdin)
  }
}

/**
 * Resolve the shared Harness home below the operating-system user home.
 * @param userHome - Home directory reported by Electron.
 * @returns Cross-platform path used as `DSH_HOME` by the supervised CLI.
 */
export function resolveHarnessHome(userHome: string): string {
  return join(userHome, '.dsh')
}

/**
 * Build the Node-compatible child arguments for the Desktop Host entry.
 * @param appPath - Electron application root.
 * @param hostModule - Absolute path to the built Desktop Host module.
 * @param patchPath - Ownership overlay patch path.
 * @returns Electron child-mode arguments for a random-port Web launch.
 */
export function harnessArguments(appPath: string, hostModule: string, patchPath: string): string[] {
  return [
    '--expose-internals',
    hostModule,
    appPath,
    patchPath,
    '--',
    '--port',
    '0',
    '--no-open',
  ]
}

/**
 * Resolve the packaged Desktop Host module below Electron's application root.
 * @param appPath - Electron application root.
 * @returns Absolute path of the compiled Host entry.
 */
export function resolveHostModule(appPath: string): string {
  return join(appPath, 'lib', 'host.js')
}

/**
 * Resolve the packaged dsh executable module below Electron's application root.
 * @param appPath - Electron application root, including an app.asar path in production.
 * @returns Absolute path accepted by Electron's Node-compatible child mode.
 */
export function resolveDshBin(appPath: string): string {
  return join(appPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/**
 * Resolve the supervised `dsh` installation's package.json.
 * Bundle lookup uses this anchor, matching `dsh web` launched from the packaged CLI.
 * @param appPath - Electron application root.
 * @returns Absolute path of `@deepseek-ai/dsh/package.json`.
 */
export function resolveDshInstallAnchor(appPath: string): string {
  return join(appPath, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
}

/** Bytes of Host stdout retained while waiting for the readiness line. */
export const HARNESS_STARTUP_BUFFER_LIMIT = 256 * 1024

/** Handshake buffer used only until `dsh web` reports a loopback URL. */
export interface HarnessStartupScan {
  output: string
  settled: boolean
}

/**
 * Scan one stdout chunk for the readiness URL, then drop the handshake buffer.
 * Callers must skip this helper after `settled` so Host logs are not retained.
 * @param scan - Mutable handshake state owned by the supervisor.
 * @param text - Decoded stdout chunk.
 * @returns The validated readiness URL when this chunk completes the handshake.
 */
export function scanHarnessStartupChunk(scan: HarnessStartupScan, text: string): string | undefined {
  if (scan.settled) return undefined
  scan.output += text
  const url = parseHarnessReadyUrl(scan.output)
  if (url !== undefined) {
    scan.settled = true
    scan.output = ''
    return url
  }
  if (scan.output.length > HARNESS_STARTUP_BUFFER_LIMIT) {
    scan.output = scan.output.slice(scan.output.length - HARNESS_STARTUP_BUFFER_LIMIT)
  }
  return undefined
}

/**
 * Read the loopback readiness URL emitted by the upstream Web composition.
 * @param output - Accumulated standard output; the readiness line may follow other logs.
 * @returns The validated loopback URL, or undefined until a complete line is present.
 */
export function parseHarnessReadyUrl(output: string): string | undefined {
  const match = /^dsh web: (http:\/\/127\.0\.0\.1:(\d+)(?:\/\?token=[A-Za-z0-9_-]+)?)(?:\s|$)/m.exec(output)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return match[1]
}
