import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { publishWindowsStore } from '../scripts/publish-windows-store.mjs'
import { storeReleaseVersion } from '../scripts/store-release-version.mjs'

const identity = {
  productId: '9P5FQ7D2PQVQ',
  identityName: 'CherrchenSoftware.Rivetdeck',
  publisher: 'CN=927251ED-C4FA-409B-8A38-C2D78ECAA60A',
}
const version = '1.0.123.0'
const app = {
  Id: identity.productId,
  PackageIdentityName: identity.identityName,
  PublisherName: identity.publisher,
  PendingApplicationSubmission: null,
  LastPublishedApplicationSubmission: { Id: 'published' },
}
const published = {
  Id: 'published',
  ApplicationPackages: ['x64', 'arm64'].map(arch => ({ FileName: `previous-${arch}.appx`, Version: '1.0.0.0', Architecture: arch.toUpperCase(), FileStatus: 'Uploaded' })),
}
const draft = {
  Id: 'draft',
  TargetPublishMode: 'Manual',
  Pricing: { PriceId: 'Free' },
  Listings: { 'en-us': { BaseListing: { Description: 'Rivetdeck', Images: [{ FileName: 'home.png', FileStatus: 'Uploaded' }] } } },
  NotesForCertification: 'Existing reviewer instructions',
  ApplicationPackages: [
    ...published.ApplicationPackages,
    ...['x64', 'arm64'].map(arch => ({ FileName: `Rivetdeck-store-${version}-${arch}.appx`, FileStatus: 'PendingUpload' })),
  ],
}

async function withPackages(action: (directory: string, payload: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), 'rivetdeck-store-release-test-'))
  try {
    const directory = join(temporary, 'packages')
    await mkdir(directory)
    for (const arch of ['x64', 'arm64']) await writeFile(join(directory, `Rivetdeck-store-${version}-${arch}.appx`), arch)
    await action(directory, join(temporary, 'submission.json'))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

function commands(responses: object[]) {
  return vi.fn(async (_args: string[]) => {
    const response = responses.shift()
    if (response === undefined) throw new Error('Unexpected Microsoft Store command')
    return JSON.stringify(response)
  })
}

describe('Desktop release Store versions', () => {
  it.each([
    ['1', '1.0.1.0'], ['123', version], ['65535', '1.0.65535.0'],
    ['65536', '1.1.0.0'], ['4294967295', '1.65535.65535.0'],
  ])('maps run %s to %s independently of desktop semver', (run, expected) => {
    expect(storeReleaseVersion(run)).toBe(expected)
  })

  it.each(['', '0', '-1', '1.5', '01', '4294967296', '9007199254740993'])('refuses invalid run %s', (run) => {
    expect(() => storeReleaseVersion(run)).toThrow('Store release')
  })
})

describe('Microsoft Store release submission', () => {
  it('submits both architectures together, retires all predecessors, and preserves listing metadata', async () => {
    await withPackages(async (directory, payload) => {
      const run = vi.fn(async (args: string[]): Promise<string> => {
        switch (run.mock.calls.length) {
          case 1: case 3: return JSON.stringify(app)
          case 2: return JSON.stringify(published)
          case 4: return ''
          case 5: return JSON.stringify({ ...app, PendingApplicationSubmission: { Id: 'draft' } })
          case 6: return JSON.stringify(draft)
          case 7: return ''
          case 8: return readFile(payload, 'utf8')
          case 9: case 10: return ''
          default: throw new Error(`Unexpected command ${args[0]}`)
        }
      })
      await expect(publishWindowsStore(identity, version, directory, payload, run)).resolves.toEqual({ status: 'submitted', submissionId: 'draft' })
      const submitted: unknown = JSON.parse(await readFile(payload, 'utf8'))
      expect(submitted).toMatchObject({
        TargetPublishMode: 'Immediate', TargetPublishDate: '1601-01-01T00:00:00Z',
        Pricing: draft.Pricing, Listings: draft.Listings, NotesForCertification: draft.NotesForCertification,
        ApplicationPackages: [
          ...published.ApplicationPackages.map(item => ({ ...item, FileStatus: 'PendingDelete' })),
          ...draft.ApplicationPackages.slice(2),
        ],
      })
      expect(run.mock.calls[3]?.[0]).toEqual(['publish', expect.any(String), '--appId', identity.productId, '--inputDirectory', directory, '--noCommit'])
      expect(run.mock.calls.slice(-2).map(call => call[0])).toEqual([
        ['submission', 'publish', identity.productId], ['submission', 'poll', identity.productId],
      ])
    })
  })

  it('recognizes an already published version without creating another submission', async () => {
    await withPackages(async (directory, payload) => {
      const run = commands([app, {
        ...published, ApplicationPackages: published.ApplicationPackages.map(item => ({ ...item, Version: version })),
      }])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).resolves.toEqual({ status: 'already-published', submissionId: 'published' })
      expect(run).toHaveBeenCalledTimes(2)
    })
  })

  it.each([
    [{ ...app, PendingApplicationSubmission: { Id: 'manual-draft' } }, 'pending submission'],
    [{ ...app, LastPublishedApplicationSubmission: null }, 'initial published submission'],
    [{ ...app, PackageIdentityName: 'another-product' }, 'identity differs'],
  ])('refuses unavailable or different applications before writing remotely', async (application, message) => {
    await withPackages(async (directory, payload) => {
      const run = commands([application])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow(message)
      expect(run).toHaveBeenCalledTimes(1)
    })
  })

  it.each([version, '1.1.0.0'])('refuses equal or newer published package %s unless both architectures match', async (existing) => {
    await withPackages(async (directory, payload) => {
      const run = commands([app, { ...published, ApplicationPackages: [
        { ...published.ApplicationPackages[0], Version: existing }, published.ApplicationPackages[1],
      ] }])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow('must exceed')
      expect(run).toHaveBeenCalledTimes(2)
    })
  })

  it('stops when a pending submission appears before upload', async () => {
    await withPackages(async (directory, payload) => {
      const run = commands([app, published, { ...app, PendingApplicationSubmission: { Id: 'other-run' } }])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow('changed before upload')
      expect(run).toHaveBeenCalledTimes(3)
    })
  })

  it('refuses extra artifacts before contacting Partner Center', async () => {
    await withPackages(async (directory, payload) => {
      await writeFile(join(directory, 'unqualified.appx'), '')
      const run = commands([])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow('exactly the qualified')
      expect(run).not.toHaveBeenCalled()
    })
  })

  it('does not commit a draft missing the ARM64 upload', async () => {
    await withPackages(async (directory, payload) => {
      const run = commands([app, published, app, {}, { ...app, PendingApplicationSubmission: { Id: 'draft' } }, {
        ...draft, ApplicationPackages: draft.ApplicationPackages.slice(0, -1),
      }])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow('missing uploaded package')
      expect(run.mock.calls.some(call => call[0][0] === 'submission' && call[0][1] === 'publish')).toBe(false)
    })
  })

  it('does not commit when Partner Center retains manual publication', async () => {
    await withPackages(async (directory, payload) => {
      const run = commands([app, published, app, {}, { ...app, PendingApplicationSubmission: { Id: 'draft' } }, draft, {}, draft])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow('automatic publication setting')
      expect(run).toHaveBeenCalledTimes(8)
    })
  })

  it('reports commit failures without recording submission success', async () => {
    await withPackages(async (directory, payload) => {
      const run = vi.fn(async (args: string[]): Promise<string> => {
        if (args[0] === 'submission' && args[1] === 'publish') throw new Error('commit failed')
        const step = run.mock.calls.length
        if (step === 8) return readFile(payload, 'utf8')
        return JSON.stringify([app, published, app, {}, { ...app, PendingApplicationSubmission: { Id: 'draft' } }, draft, {}][step - 1])
      })
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow('commit failed')
      expect(run).toHaveBeenCalledTimes(9)
    })
  })
})
