import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { publishWindowsStore } from '../scripts/publish-windows-store.mjs'
import { storeReleaseVersion } from '../scripts/store-release-version.mjs'
import { restoreWindowsStoreVersion } from '../scripts/restore-windows-store-version.mjs'

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
const updatedDraft = {
  ...draft,
  TargetPublishMode: 'Immediate',
  ApplicationPackages: draft.ApplicationPackages.map(item => ({
    ...item, FileStatus: item.FileName.startsWith('previous-') ? 'PendingDelete' : 'PendingUpload',
  })),
}
const accepted = {
  ...updatedDraft,
  Status: 'PreProcessing',
  StatusDetails: { Errors: [] },
  ApplicationPackages: ['x64', 'arm64'].map(arch => ({
    FileName: `Rivetdeck-store-${version}-${arch}.appx`, FileStatus: 'Uploaded', Version: version, Architecture: arch.toUpperCase(),
  })),
}

function commitCommands(confirmation: object) {
  return commands([app, published, app, {}, { ...app, PendingApplicationSubmission: { Id: 'draft' } }, draft, {}, updatedDraft, {}, {}, confirmation])
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

describe('Reused Microsoft Store package versions', () => {
  const configuration = { ...identity, publisherDisplayName: 'Cherrchen Software', version: '1.0.0.0' }

  async function withArtifact(names: string[], action: (project: string, directory: string) => Promise<void>) {
    const project = await mkdtemp(join(tmpdir(), 'rivetdeck-store-reuse-'))
    try {
      const directory = join(project, 'packages')
      await mkdir(directory)
      await writeFile(join(project, 'windows-store.json'), `${JSON.stringify(configuration)}\n`)
      for (const name of names) await writeFile(join(directory, name), '')
      await action(project, directory)
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  }

  it.each([
    ['x64', version], ['arm64', version], ['x64', '1.1.0.0'], ['arm64', '1.0.0.0'],
  ])('restores %s artifact version %s while retaining Partner Center identity', async (architecture, sourceVersion) => {
    await withArtifact([`Rivetdeck-store-${sourceVersion}-${architecture}.appx`], async (project, directory) => {
      await expect(restoreWindowsStoreVersion(project, directory, architecture)).resolves.toBe(sourceVersion)
      expect(JSON.parse(await readFile(join(project, 'windows-store.json'), 'utf8'))).toEqual({
        ...configuration, version: sourceVersion,
      })
    })
  })

  it.each([
    [[], 'x64', 'exactly one'],
    [[`Rivetdeck-store-${version}-x64.appx`, 'extra.appx'], 'x64', 'exactly one'],
    [[`Rivetdeck-store-${version}-arm64.appx`], 'x64', 'artifact name'],
    [['another-product-1.0.123.0-x64.appx'], 'x64', 'artifact name'],
    [['Rivetdeck-store-1.0.123.1-x64.appx'], 'x64', 'Store version'],
    [['Rivetdeck-store-1.65536.0.0-x64.appx'], 'x64', 'Store version'],
    [['Rivetdeck-store-01.0.123.0-x64.appx'], 'x64', 'Store version'],
    [[`Rivetdeck-store-${version}-x64.appx`], 'ia32', 'x64 or arm64'],
  ])('refuses invalid artifact set %j for %s without changing configuration', async (names, architecture, message) => {
    await withArtifact(names, async (project, directory) => {
      const path = join(project, 'windows-store.json')
      const before = await readFile(path, 'utf8')
      await expect(restoreWindowsStoreVersion(project, directory, architecture)).rejects.toThrow(message)
      expect(await readFile(path, 'utf8')).toBe(before)
    })
  })
})

describe('Microsoft Store release submission', () => {
  it('confirms commit processing and both accepted architectures while preserving listing metadata', async () => {
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
          case 11: return JSON.stringify(accepted)
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
      const cliProject = join(dirname(payload), 'project')
      expect(run.mock.calls[3]?.[0][1]).toBe(cliProject)
      expect(JSON.parse(await readFile(join(cliProject, 'package.json'), 'utf8'))).toEqual({
        name: 'rivetdeck-store-submission', private: true, version: '1.0.0',
        build: { appx: { identityName: identity.identityName, publisher: identity.publisher, applicationId: 'Rivetdeck' } },
      })
      expect(run).toHaveBeenCalledTimes(11)
      expect(run.mock.calls.slice(-3).map(call => call[0])).toEqual([
        ['submission', 'publish', identity.productId],
        ['submission', 'poll', identity.productId],
        ['submission', 'get', identity.productId],
      ])
    })
  })

  it.each(['PreProcessing', 'Certification', 'PendingPublication', 'Publishing', 'Release', 'Published'])('confirms submission after commit processing reaches %s', async (status) => {
    await withPackages(async (directory, payload) => {
      const run = commitCommands({ ...accepted, Status: status })
      await expect(publishWindowsStore(identity, version, directory, payload, run)).resolves.toEqual({ status: 'submitted', submissionId: 'draft' })
    })
  })

  it.each(['None', 'PendingCommit', 'CommitStarted', 'CommitFailed', 'PreProcessingFailed', 'CertificationFailed', 'ReleaseFailed', 'PublishFailed', 'Canceled'])('rejects CLI success when Partner Center remains %s', async (status) => {
    await withPackages(async (directory, payload) => {
      const run = commitCommands({ ...accepted, Status: status })
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow(`is ${status} after commit processing`)
      expect(run).toHaveBeenCalledTimes(11)
    })
  })

  it.each([
    [{ ...accepted, Id: 'another-submission' }, 'changed during commit processing'],
    [{ ...accepted, TargetPublishMode: 'Manual' }, 'changed during commit processing'],
    [{ ...accepted, Status: 'unknown' }, 'unknown submission status'],
    [{ ...accepted, ApplicationPackages: accepted.ApplicationPackages.slice(0, 1) }, 'not accepted both'],
    [{ ...accepted, ApplicationPackages: draft.ApplicationPackages.slice(2) }, 'not accepted both'],
    [{ ...accepted, ApplicationPackages: accepted.ApplicationPackages.map(item => ({ ...item, Version: '1.0.124.0' })) }, 'not accepted both'],
    [{ ...accepted, ApplicationPackages: accepted.ApplicationPackages.map(item => ({ ...item, Architecture: 'X86' })) }, 'not accepted both'],
    [{ ...accepted, ApplicationPackages: [...accepted.ApplicationPackages, published.ApplicationPackages[0]] }, 'not accepted both'],
  ])('rejects a changed or incomplete commit result without reporting submitted', async (confirmation, message) => {
    await withPackages(async (directory, payload) => {
      await expect(publishWindowsStore(identity, version, directory, payload, commitCommands(confirmation))).rejects.toThrow(message)
    })
  })

  it.each([
    [{ Code: 'InvalidState', Details: 'https://upload.invalid/?sig=private-upload-token' }],
    'private-upload-token',
  ])('reports commit validation errors without exposing upload credentials', async (errors) => {
    await withPackages(async (directory, payload) => {
      const run = commitCommands({ ...accepted, StatusDetails: { Errors: errors } })
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toEqual(
        new Error('Partner Center reported submission errors after commit processing; inspect the submission before retrying'),
      )
    })
  })

  it('propagates commit polling failures without reporting submission success', async () => {
    await withPackages(async (directory, payload) => {
      const responses = commitCommands(accepted)
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === 'submission' && args[1] === 'poll') throw new Error('commit processing failed')
        return responses(args)
      })
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow('commit processing failed')
      expect(run.mock.calls.at(-1)?.[0]).toEqual(['submission', 'poll', identity.productId])
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

  it('does not treat deleted packages as the currently published release', async () => {
    await withPackages(async (directory, payload) => {
      const run = commands([app, {
        ...published, ApplicationPackages: [
          ...published.ApplicationPackages.map(item => ({ ...item, Version: version, FileStatus: 'PendingDelete' })),
          ...published.ApplicationPackages.map(item => ({ ...item, Version: '1.0.124.0' })),
        ],
      }])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow('must exceed')
      expect(run).toHaveBeenCalledTimes(2)
    })
  })

  it('requires a higher version than retired packages in the published submission', async () => {
    await withPackages(async (directory, payload) => {
      const run = commands([app, {
        ...published, ApplicationPackages: [
          ...published.ApplicationPackages,
          { FileName: 'retired-x86.appx', Version: '1.0.124.0', Architecture: 'X86', FileStatus: 'PendingDelete' },
        ],
      }])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow('must exceed')
      expect(run).toHaveBeenCalledTimes(2)
    })
  })

  it('omits malformed CLI output from errors because it may contain an upload SAS', async () => {
    await withPackages(async (directory, payload) => {
      const run = vi.fn(async () => 'https://upload.invalid/?sig=private-upload-token')
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow('Invalid Microsoft Store CLI JSON')
    })
  })

  it.each([
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

  it('defers when a pending submission appears before upload', async () => {
    await withPackages(async (directory, payload) => {
      const run = commands([app, published, { ...app, PendingApplicationSubmission: { Id: 'other-run' } }, { Id: 'other-run', Status: 'Certification' }])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).resolves.toEqual({ status: 'deferred', submissionId: 'other-run' })
      expect(run).toHaveBeenCalledTimes(4)
    })
  })

  it.each(['CommitStarted', 'PreProcessing', 'Certification', 'PendingPublication', 'Publishing', 'Release', 'Published'])('keeps releases queued while Partner Center is %s', async (status) => {
    await withPackages(async (directory, payload) => {
      const run = commands([{ ...app, PendingApplicationSubmission: { Id: 'in-flight' } }, { Id: 'in-flight', Status: status }])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).resolves.toEqual({ status: 'deferred', submissionId: 'in-flight' })
      expect(run.mock.calls.map(call => call[0])).toEqual([['apps', 'get', identity.productId], ['submission', 'get', identity.productId]])
    })
  })

  it.each(['PendingCommit', 'CommitFailed', 'PreProcessingFailed', 'CertificationFailed', 'ReleaseFailed', 'PublishFailed', 'Canceled', 'None', 'Unrecognized'])('reports %s for intervention without overwriting a submission', async (status) => {
    await withPackages(async (directory, payload) => {
      const run = commands([{ ...app, PendingApplicationSubmission: { Id: 'blocked' } }, { Id: 'blocked', Status: status }])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow(`is ${status}`)
      expect(run).toHaveBeenCalledTimes(2)
    })
  })

  it('refuses a changed pending submission during status lookup', async () => {
    await withPackages(async (directory, payload) => {
      const run = commands([{ ...app, PendingApplicationSubmission: { Id: 'in-flight' } }, { Id: 'different', Status: 'Published' }])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow('changed during status check')
    })
  })

  it('reports a submission waiting for Publish now instead of silently deferring forever', async () => {
    await withPackages(async (directory, payload) => {
      const run = commands([{ ...app, PendingApplicationSubmission: { Id: 'manual' } }, {
        Id: 'manual', Status: 'PendingPublication', TargetPublishMode: 'Manual',
      }])
      await expect(publishWindowsStore(identity, version, directory, payload, run)).rejects.toThrow('requires Publish now')
      expect(run).toHaveBeenCalledTimes(2)
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
