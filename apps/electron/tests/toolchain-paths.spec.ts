import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDesktopToolchains } from '../src/toolchains/resolver.ts'

describe('Desktop toolchain paths', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    for (const arch of ['x64', 'arm64']) {
      for (const packaged of [true, false]) {
        it(`resolves ${platform}-${arch} ${packaged ? 'packaged' : 'development'} assets`, () => {
          const roots = packaged
            ? join('/resources', 'toolchains')
            : join('/app', '.electron-build', 'toolchains')
          const suffix = packaged ? [] : [`${platform}-${arch}`]
          const nodeRoot = join(roots, 'node', ...suffix)
          const pythonRoot = join(roots, 'python', ...suffix)
          const resolved = resolveDesktopToolchains({
            appPath: '/app', resourcesPath: '/resources', packaged, platform, arch, exists: () => true,
          })
          expect(resolved.node.executable).toBe(join(nodeRoot, platform === 'win32' ? 'node.exe' : 'bin/node'))
          expect(resolved.python.executable).toBe(join(pythonRoot, platform === 'win32' ? 'python.exe' : 'bin/python3'))
          expect(resolved.npmCli).toBe(join(nodeRoot, platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'npm', 'bin', 'npm-cli.js'))
        })
      }
    }
  }

  it('fails before Host startup when any required executable is missing', () => {
    expect(() => resolveDesktopToolchains({
      appPath: '/app', resourcesPath: '/resources', packaged: true, platform: 'linux', arch: 'x64', exists: () => false,
    })).toThrow(/missing asset/u)
  })
})
