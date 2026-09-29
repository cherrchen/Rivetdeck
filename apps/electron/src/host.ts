/**
 * Supervised Desktop Host entry: boots the shared web profile with a
 * process-private resolution directory so ecosystem packages resolve to
 * Electron-bundled copies without rewriting `$DSH_HOME/profiles/web`.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  createRuntimeResolution,
  installFailLoud,
  loadLayeredEnv,
  loadOverlayPatches,
  loadProfileDirectory,
  PluginPackages,
  PROFILE_PATCH_FILENAME,
  readProfilePatches,
  reportSkippedBundles,
  resolveProfileDir,
  type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline, type AppReady } from '@deepseek-ai/dsh-cmdline'
import { WEB_PROFILE_NAME } from './ecosystem-profile.ts'
import {
  HOST_PROFILE_ROOT_CONFIG,
  HOST_PROFILE_ROOT_FILENAME,
  prepareHostProfileProjection,
} from './host-profile.ts'
import { resolveDshInstallAnchor } from './runtime.ts'

const NAME = 'dsh'

/** Bounded process exit after Host disposal. */
const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000

interface HostLaunchOptions {
  /** Electron application root. */
  appPath: string
  /** Ownership overlay patch path. */
  patchPath: string
  /** Inner web-app arguments after launcher flags. */
  args: readonly string[]
}

/**
 * Parse Host argv: `host.js <appPath> <patchPath> [-- <web-args...>]`.
 * @param argv - Arguments after the Host module path.
 * @returns Launch options.
 */
export function parseHostArguments(argv: readonly string[]): HostLaunchOptions {
  const appPath = argv[0]
  const patchPath = argv[1]
  if (appPath === undefined || patchPath === undefined) {
    throw new Error('electron host: expected <appPath> <patchPath> [web-args...]')
  }
  const separator = argv.indexOf('--')
  const args = separator === -1 ? argv.slice(2) : argv.slice(separator + 1)
  return {
    appPath: resolve(appPath),
    patchPath: resolve(patchPath),
    args: args.length > 0 ? args : ['--port', '0', '--no-open'],
  }
}

/** Launcher-owned readiness signal committed only after boot succeeds. */
function createAppReady(): { service: AppReady; commit(): void } {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

/** Process-exit controller matching the CLI Host lifecycle. */
function createProcessShutdown(dispose: () => Promise<void>): {
  shutdown(code: number): Promise<void>
  interrupt(code: number): void
} {
  let pending: Promise<void> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let completed = false
  let forceExited = false
  const forceExitOnce = (code: number): void => {
    if (forceExited) return
    forceExited = true
    if (timeout !== undefined) clearTimeout(timeout)
    process.exit(code)
  }
  const start = (code: number, forceAfterDispose: boolean): Promise<void> => {
    if (pending !== undefined) return pending
    timeout = setTimeout(() => { forceExitOnce(code) }, PROCESS_SHUTDOWN_TIMEOUT_MS)
    pending = Promise.resolve().then(dispose).then(
      () => {
        if (forceAfterDispose) forceExitOnce(code)
        else if (!completed && !forceExited) {
          completed = true
          if (timeout !== undefined) clearTimeout(timeout)
          process.exitCode = code
        }
      },
      () => { forceExitOnce(code) },
    )
    return pending
  }
  return {
    shutdown(code) { return start(code, false) },
    interrupt(code) {
      if (pending !== undefined) {
        forceExitOnce(code)
        return
      }
      void start(code, true)
    },
  }
}

/**
 * Boot the Desktop Host with split persistence and resolution directories.
 * @param options - Application paths and web-app arguments.
 * @returns Settled root context.
 */
export async function runDesktopHost(options: HostLaunchOptions): Promise<{ ctx: Context }> {
  const environment = loadLayeredEnv(NAME)
  const disposeProxy = await installProxyFromEnvironment(
    environment,
    (message) => { process.stderr.write(`${NAME}: ${message}\n`) },
  )
  const home = resolveDshHome()
  const webDir = resolveProfileDir(WEB_PROFILE_NAME, home)
  if (!existsSync(join(webDir, 'package.json'))) {
    throw new Error(`electron host: shared web profile missing at ${webDir}`)
  }
  const hostDir = prepareHostProfileProjection(options.appPath, home)
  if (hostDir === undefined) {
    throw new Error(`electron host: shared web profile missing at ${webDir}`)
  }
  writeFileSync(join(hostDir, HOST_PROFILE_ROOT_FILENAME), HOST_PROFILE_ROOT_CONFIG)
  const installAnchor = resolveDshInstallAnchor(options.appPath)
  const resolutionProfile = loadProfileDirectory(NAME, hostDir, installAnchor)
  reportSkippedBundles(NAME, resolutionProfile)
  const resolution = await createRuntimeResolution({
    installAnchor,
    profile: resolutionProfile,
    home,
  })
  const overlays: PatchOptions[] = loadOverlayPatches(NAME, options.patchPath)

  const app: { current?: Context } = {}
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => disposal ??= (async () => {
    const failures: unknown[] = []
    for (const release of [() => app.current?.fiber.dispose(), disposeProxy]) {
      try { await release() } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'dsh: profile cleanup failed')
  })()

  try {
    const appReady = createAppReady()
    const shutdown = createProcessShutdown(dispose)
    const signalShutdown = new AbortController()
    const interrupt = (code: number): void => {
      signalShutdown.abort()
      shutdown.interrupt(code)
    }
    process.on('SIGTERM', () => { interrupt(0) })
    process.on('SIGINT', () => { interrupt(130) })
    installFailLoud(NAME, process, async () => {
      await app.current?.fiber.dispose()
    })

    const rootConfig = join(hostDir, HOST_PROFILE_ROOT_FILENAME)
    const profileContext: ProfileContext = {
      name: WEB_PROFILE_NAME,
      dir: webDir,
      patchPath: join(webDir, PROFILE_PATCH_FILENAME),
      installAnchor,
      startedBundles: resolutionProfile.layers.map(layer => layer.packageName),
      cwd: process.cwd(),
      home,
      overlays,
      telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    }
    // Persistence stays on the shared web profile. Resolution used the private
    // projection above so ecosystem imports hit Electron-bundled packages.
    const ctx = await boot(
      NAME,
      rootConfig,
      readProfilePatches(NAME, {
        ...profileContext,
        dir: hostDir,
        patchPath: join(hostDir, PROFILE_PATCH_FILENAME),
      }, resolutionProfile),
      async (hostCtx) => {
        app.current = hostCtx
        hostCtx.provide('profileContext', profileContext)
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        await hostCtx.plugin(PluginPackages, { resolution })
        provideCmdline(hostCtx, {
          args: options.args,
          exit: code => void shutdown.shutdown(code),
          ready: appReady.service,
        })
      },
    )
    app.current = ctx
    if (!signalShutdown.signal.aborted
      && ctx.fiber.state === FiberState.ACTIVE
      && ctx.get('loader') !== undefined) {
      appReady.commit()
    }
    return { ctx }
  } catch (error) {
    try { await dispose() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'dsh: profile startup and cleanup failed')
    }
    throw error
  }
}

if (import.meta.main) {
  const options = parseHostArguments(process.argv.slice(2))
  await runDesktopHost(options).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
