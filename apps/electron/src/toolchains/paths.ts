import { join } from 'node:path'

/** Resolve normalized asset directories for a packaged or source Desktop. */
export function toolchainRoots(options: {
  appPath: string
  resourcesPath: string
  packaged: boolean
  platform: NodeJS.Platform
  arch: string
}): { node: string; python: string } {
  const root = options.packaged
    ? join(options.resourcesPath, 'toolchains')
    : join(options.appPath, '.electron-build', 'toolchains')
  const target = `${options.platform}-${options.arch}`
  return {
    node: join(root, 'node', ...options.packaged ? [] : [target]),
    python: join(root, 'python', ...options.packaged ? [] : [target]),
  }
}
