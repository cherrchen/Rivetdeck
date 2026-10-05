import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runtimePaths } from '../src/toolchains/paths.ts'
import { requireRuntimeName } from '../src/toolchains/domain.ts'

describe('managed runtime executable paths', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    for (const arch of ['x64', 'arm64']) {
      it(`resolves user-owned ${platform}-${arch} interpreter and package commands`, () => {
        const root = join('/userData', 'managed-toolchains', 'node', '24.17.0', `${platform}-${arch}`)
        const node = runtimePaths('node', root, '24.17.0', platform).node!
        expect(node.executable).toBe(join(root, platform === 'win32' ? 'node.exe' : 'bin/node'))
        expect(node.npmCli).toBe(join(root, platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'npm/bin/npm-cli.js'))
        expect(runtimePaths('python', root, '3.14.7', platform).python!.executable).toBe(join(root, platform === 'win32' ? 'python.exe' : 'bin/python3'))
      })
    }
  }
  it('rejects invalid IPC runtime names', () => {
    expect(requireRuntimeName('node')).toBe('node')
    expect(requireRuntimeName('python')).toBe('python')
    for (const value of ['core', '../node', null, 1, {}]) expect(() => requireRuntimeName(value)).toThrow(/invalid runtime name/u)
  })
})
