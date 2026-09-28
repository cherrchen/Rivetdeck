import { describe, expect, it } from 'vitest'
import lock from '../toolchains.lock.json'

const targets = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']
const pythonTargets = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc', 'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']

describe('Desktop toolchain lock', () => {
  it('pins official complete distributions for every release target', () => {
    expect(lock.schemaVersion).toBe(1)
    expect(lock.node.version).toBe('24.17.0')
    expect(lock.python.version).toBe('3.14.7')
    expect(lock.python.release).toBe('20260924')
    expect(lock.python.flavor).toBe('install_only_stripped')
    for (const runtime of [lock.node, lock.python]) {
      expect(Object.keys(runtime.targets).sort()).toEqual([...targets].sort())
      for (const entry of Object.values(runtime.targets) as Array<{ url: string; sha256: string }>) {
        expect(entry.url).toMatch(/^https:\/\//u)
        expect(entry.url).not.toMatch(/latest/iu)
        expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/u)
      }
    }
    for (const entry of Object.values(lock.node.targets) as Array<{ url: string }>) {
      expect(entry.url).toContain('v24.17.0')
    }
    for (const [index, target] of targets.entries()) {
      const entry = lock.python.targets[target as keyof typeof lock.python.targets]
      expect(entry.target).toBe(pythonTargets[index])
      expect(entry.url).toContain('20260924')
      expect(entry.url).toContain('3.14.7')
    }
  })
})
