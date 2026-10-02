import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'

/** Runtime paths required to expose the Desktop-bundled pnpm to upstream dsh. */
export interface PluginPackageManagerRuntime {
  /** Directory containing the generated platform shim. */
  binDirectory: string
  /** PATH value with the generated shim directory first. */
  envPath: string
}

/**
 * Resolve pnpm's packaged CommonJS entrypoint.
 * @param appPath - Electron application root.
 * @returns absolute packaged pnpm entrypoint.
 */
export function resolveBundledPnpmBin(appPath: string): string {
  return join(appPath, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
}

/**
 * Create a platform shim named `pnpm` for the upstream profile manager and prepend it to PATH.
 * @param harnessHome - Active DSH home.
 * @param nodeExecutable - Core-owned Node-compatible executor the shim launches.
 * @param pnpmBin - Bundled pnpm entrypoint.
 * @param currentPath - Ambient PATH retained after the controlled shim directory.
 * @param platform - Target process platform.
 * @returns Shim directory and PATH value for the supervised Host.
 */
export function preparePluginPackageManager(
  harnessHome: string,
  nodeExecutable: string,
  pnpmBin: string,
  currentPath = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): PluginPackageManagerRuntime {
  if (!existsSync(pnpmBin)) throw new Error(`plugin package manager: bundled pnpm missing at ${pnpmBin}`)
  const binDirectory = join(harnessHome, 'electron', 'bin')
  mkdirSync(binDirectory, { recursive: true })
  if (platform === 'win32') {
    const shim = join(binDirectory, 'pnpm.cmd')
    writeFileSync(shim, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${escapeCmd(nodeExecutable)}" "${escapeCmd(pnpmBin)}" %*\r\n`, 'utf8')
  } else {
    const shim = join(binDirectory, 'pnpm')
    writeFileSync(shim, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${escapeShell(nodeExecutable)}' '${escapeShell(pnpmBin)}' "$@"\n`, { encoding: 'utf8', mode: 0o700 })
    chmodSync(shim, 0o700)
    const nodeShim = join(binDirectory, 'node')
    writeFileSync(nodeShim, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${escapeShell(nodeExecutable)}' "$@"\n`, { encoding: 'utf8', mode: 0o700 })
    chmodSync(nodeShim, 0o700)
  }
  return { binDirectory, envPath: [binDirectory, ...(platform === 'win32' ? [dirname(nodeExecutable)] : []), currentPath].join(delimiter) }
}

function escapeShell(value: string): string {
  return value.replaceAll("'", "'\\''")
}

function escapeCmd(value: string): string {
  if (value.includes('"') || /[\r\n]/.test(value)) throw new Error('plugin package manager: executable path is invalid')
  return value.replaceAll('%', '%%')
}
