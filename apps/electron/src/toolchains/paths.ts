import { dirname, join } from 'node:path'
import type { DesktopToolchains, RuntimeName } from './domain.ts'

/** Describe one installed user-data generation without resolving Core resources.
 * @param name Runtime selector.
 * @param root Verified installation directory.
 * @param version Persisted version.
 * @param platform Target operating system.
 * @returns Runtime executable and package command paths.
 */
export function runtimePaths(name: RuntimeName, root: string, version: string, platform: NodeJS.Platform): DesktopToolchains {
  const windows = platform === 'win32'
  if (name === 'python') {
    const executable = join(root, windows ? 'python.exe' : 'bin/python3')
    return { python: { executable, version, binDirectory: dirname(executable) } }
  }
  const executable = join(root, windows ? 'node.exe' : 'bin/node')
  const npm = join(root, windows ? 'node_modules/npm/bin' : 'lib/node_modules/npm/bin')
  return { node: { executable, version, binDirectory: dirname(executable), npmCli: join(npm, 'npm-cli.js'), npxCli: join(npm, 'npx-cli.js') } }
}
