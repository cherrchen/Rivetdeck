import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseToolchainPolicy, toolchainOverrides } from '../runtime/plugins/desktop-network-subprocess/src/toolchains.ts'

const policy = parseToolchainPolicy(JSON.stringify({
  version: 2, mode: 'fallback', basePath: resolve('/system/bin'),
  node: { executable: resolve('/bundle/node/bin/node'), binDirectory: resolve('/bundle/node/bin'), version: '24.17.0' },
  python: { executable: resolve('/bundle/python/bin/python3'), binDirectory: resolve('/bundle/python/bin'), version: '3.14.7' },
  shimDirectory: resolve('/user/toolchains/bin'), pythonUserBase: resolve('/user/python'),
  nodeGlobalBinDirectory: resolve('/user/node-global/bin'), pythonUserBinDirectory: resolve('/user/python/bin'),
}))
if (policy === undefined) throw new Error('policy fixture missing')
const empty = createLaunchEnvironmentSnapshot([])

describe('Desktop Agent PATH fallback', () => {
  it('keeps system PATH first and appends managed commands', () => {
    expect(toolchainOverrides(undefined, policy, empty, 'linux').PATH).toBe(
      [policy.basePath, policy.shimDirectory, policy.nodeGlobalBinDirectory, policy.pythonUserBinDirectory, policy.node!.binDirectory, policy.python!.binDirectory].join(':'),
    )
  })

  it('places project PATH ahead of bundled assets', () => {
    const launch = createLaunchEnvironmentSnapshot([
      { source: 'project-env', values: { PATH: '/project/bin' } },
      { source: 'user-env', values: { PATH: '/user/bin' } },
    ])
    expect(toolchainOverrides(undefined, policy, launch, 'linux').PATH).toBe(
      ['/project/bin', '/user/bin', policy.basePath, policy.shimDirectory, policy.nodeGlobalBinDirectory, policy.pythonUserBinDirectory, policy.node!.binDirectory, policy.python!.binDirectory].join(':'),
    )
  })

  it('gives an explicit request PATH highest priority', () => {
    const launch = createLaunchEnvironmentSnapshot([
      { source: 'project-env', values: { PATH: '/project/bin' } },
      { source: 'user-env', values: { PATH: '/user/bin' } },
    ])
    expect(toolchainOverrides({ PATH: '/request/bin' }, policy, launch, 'linux').PATH).toBe(
      ['/request/bin', '/project/bin', '/user/bin', policy.basePath, policy.shimDirectory, policy.nodeGlobalBinDirectory, policy.pythonUserBinDirectory, policy.node!.binDirectory, policy.python!.binDirectory].join(':'),
    )
  })

  it('preserves a PATH tombstone', () => {
    expect(toolchainOverrides({ PATH: undefined }, policy, empty, 'linux').PATH).toBeUndefined()
  })

  it('does not set Python package state for an unrelated Agent process', () => {
    expect(toolchainOverrides(undefined, policy, empty, 'linux').PYTHONUSERBASE).toBeUndefined()
    expect(toolchainOverrides({ PYTHONUSERBASE: '/request/python' }, policy, empty, 'linux').PYTHONUSERBASE).toBe('/request/python')
    const launch = createLaunchEnvironmentSnapshot([{ source: 'project-env', values: { PYTHONUSERBASE: '/project/python' } }])
    expect(toolchainOverrides(undefined, policy, launch, 'linux').PYTHONUSERBASE).toBe('/project/python')
  })

  it('treats Windows PATH spellings as one name', () => {
    for (const spelling of ['PATH', 'Path', 'path']) {
      const values = toolchainOverrides({ [spelling]: 'C:\\Project' }, policy, empty, 'win32')
      expect(Object.keys(values).filter(key => key.toUpperCase() === 'PATH')).toEqual([spelling])
      expect(values[spelling]).toBe(['C:\\Project', policy.basePath, policy.shimDirectory, policy.nodeGlobalBinDirectory, policy.pythonUserBinDirectory, policy.node!.binDirectory, policy.python!.binDirectory].join(';'))
    }
    expect(toolchainOverrides({ path: undefined }, policy, empty, 'win32').path).toBeUndefined()
    const launch = createLaunchEnvironmentSnapshot([{ source: 'project-env', values: { Path: 'C:\\ProjectEnv' } }])
    expect(toolchainOverrides(undefined, policy, launch, 'win32').PATH?.startsWith('C:\\ProjectEnv;')).toBe(true)
  })

  it('rejects changed versions and extra descriptor fields', () => {
    expect(() => parseToolchainPolicy(JSON.stringify({ ...policy, extra: true }))).toThrow(/invalid policy/u)
    expect(() => parseToolchainPolicy(JSON.stringify({ ...policy, node: { ...policy.node, version: '../25' } }))).toThrow(/invalid policy/u)
  })
})

describe('optional managed fallback', () => {
  for (const node of [true, false]) for (const python of [true, false]) {
    it(`preserves explicit PATH with Node=${node} Python=${python}`, () => {
      const { node: nodePolicy, python: pythonPolicy, ...base } = policy
      const optional = parseToolchainPolicy(JSON.stringify({
        ...base, ...(node ? { node: nodePolicy } : {}), ...(python ? { python: pythonPolicy } : {}),
      }))
      if (optional === undefined) throw new Error('missing optional policy')
      const path = toolchainOverrides({ PATH: '/project' }, optional, empty, 'linux').PATH!
      expect(path.startsWith('/project:')).toBe(true)
      expect(path.includes(nodePolicy!.binDirectory)).toBe(node)
      expect(path.includes(pythonPolicy!.binDirectory)).toBe(python)
      if (!node && !python) expect(path).toBe(`/project:${base.basePath}`)
    })
  }
})
