import { describe, expect, it } from 'vitest'
import { loadManifest, validateManifest } from '../scripts/toolchains/manifest.mjs'
import { validateArchiveMember } from '../scripts/toolchains/common.mjs'

describe('Desktop toolchain manifest validation', () => {
  it('rejects a changed checksum before preparation', () => {
    const lock = structuredClone(loadManifest())
    lock.node.targets['darwin-arm64'].sha256 = '0'.repeat(63)
    expect(() => validateManifest(lock)).toThrow(/invalid node darwin-arm64/u)
  })

  it('rejects an unexpected source and version label', () => {
    const lock = structuredClone(loadManifest())
    lock.python.targets['linux-x64'].url = 'https://example.org/releases/20260924/latest.tar.gz'
    expect(() => validateManifest(lock)).toThrow(/invalid python linux-x64/u)
  })
})

describe('Desktop archive paths', () => {
  it('rejects members and links that escape the extraction directory', () => {
    expect(() => { validateArchiveMember('python/../outside') }).toThrow(/unsafe/u)
    expect(() => { validateArchiveMember('python/bin/python3', '../../../outside') }).toThrow(/unsafe/u)
  })
})
