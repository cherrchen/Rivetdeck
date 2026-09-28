import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DesktopToolchains } from './domain.ts'
import { toolchainRoots } from './paths.ts'

/** Resolve the complete packaged toolchains before starting the supervised Host. */
export function resolveDesktopToolchains(options: {
  appPath: string
  resourcesPath: string
  packaged: boolean
  platform?: NodeJS.Platform
  arch?: string
  exists?: (path: string) => boolean
}): DesktopToolchains {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const roots = toolchainRoots({ ...options, platform, arch })
  const windows = platform === 'win32'
  const node = join(roots.node, windows ? 'node.exe' : 'bin/node')
  const python = join(roots.python, windows ? 'python.exe' : 'bin/python3')
  const npmRoot = join(roots.node, windows ? 'node_modules' : 'lib/node_modules', 'npm', 'bin')
  const npmCli = join(npmRoot, 'npm-cli.js')
  const npxCli = join(npmRoot, 'npx-cli.js')
  for (const path of [node, python, npmCli, npxCli]) {
    if (!(options.exists ?? existsSync)(path)) {
      throw new Error(`desktop toolchains: missing asset ${path}; run prepare:toolchains before starting Desktop`)
    }
  }
  return {
    node: { executable: node, version: '24.17.0' },
    python: { executable: python, version: '3.14.7' },
    nodeBinDirectory: dirname(node),
    pythonBinDirectory: dirname(python),
    npmCli,
    npxCli,
  }
}
