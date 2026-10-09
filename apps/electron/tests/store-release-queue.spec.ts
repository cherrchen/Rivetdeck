import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchStoreRelease, enqueueStoreRelease, nextStoreRelease, validateStoreRequest } from '../scripts/store-release-queue.mjs'
import { publishWindowsStore } from '../scripts/publish-windows-store.mjs'

afterEach(() => vi.unstubAllEnvs())

const commit = 'a'.repeat(40)
const request = {
  runId: '12345', runNumber: 123, tag: 'v0.1.0-beta.1', commit, version: '1.0.123.0',
  packages: ['x64', 'arm64'].map(arch => ({
    name: `Rivetdeck-store-1.0.123.0-${arch}.appx`, sha256: createHash('sha256').update(arch).digest('hex'),
  })),
}

async function temporary(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'rivetdeck-store-queue-test-'))
  try {
    await writeFile(join(root, 'windows-store.json'), JSON.stringify({ productId: 'store', version: '1.0.0.0' }))
    await action(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function github(options: { active?: boolean; moved?: boolean; corrupt?: boolean; complete?: boolean; incompleteHistory?: boolean } = {}) {
  const uploaded: { tag: string; name: string; content: string }[] = []
  const run = vi.fn(async (args: string[]): Promise<string> => {
    if (args[0] === 'release') {
      const path = args[3]
      if (args[1] === 'upload' && path !== undefined) {
        uploaded.push({ tag: args[2] ?? '', name: path.split(/[\\/]/).at(-1) ?? '', content: await readFile(path, 'utf8') })
        return ''
      }
      if (args[1] === 'download') {
        const name = args[args.indexOf('--pattern') + 1] ?? ''
        const directory = args[args.indexOf('--dir') + 1] ?? ''
        await writeFile(join(directory, name), options.corrupt ? 'changed' : name.includes('-x64.') ? 'x64' : 'arm64')
        return ''
      }
    }
    const endpoint = args[1] ?? ''
    if (args.includes('.default_branch')) return 'main'
    if (endpoint.includes('/contents/.github/workflows/desktop-store-queue.yml')) return '{}'
    if (endpoint.endsWith('/actions/workflows/desktop-store-queue.yml')) return JSON.stringify({ state: 'active' })
    if (endpoint.endsWith('/releases/assets/3')) return JSON.stringify({ status: 'already-published', version: request.version, runId: request.runId, submissionId: 'published' })
    if (endpoint.includes('/actions/workflows/')) return JSON.stringify([{
      total_count: options.incompleteHistory ? 3 : 2,
      workflow_runs: [
        { run_number: 124, status: 'completed' }, { run_number: 123, status: options.active ? 'in_progress' : 'completed' },
      ],
    }])
    if (endpoint.endsWith('/releases?per_page=100')) return JSON.stringify([[{ id: 1, tag_name: request.tag, draft: false }]])
    if (endpoint.includes('/releases/tags/')) return JSON.stringify({ id: 1, draft: false })
    if (endpoint.endsWith('/releases/1/assets?per_page=100')) return JSON.stringify([[
      { id: 2, name: 'store-request-123.json' },
      ...(options.complete ? [{ id: 3, name: 'store-published-123.json' }] : []),
    ]])
    if (endpoint.endsWith('/releases/assets/2')) return JSON.stringify(request)
    if (endpoint.endsWith('/actions/runs/12345')) return JSON.stringify({ path: '.github/workflows/desktop-release.yml', run_number: 123, status: 'completed' })
    if (endpoint.includes('/commits/')) return options.moved ? 'b'.repeat(40) : commit
    throw new Error(`Unexpected GitHub command ${args.join(' ')}`)
  })
  return { run, uploaded }
}

describe('Microsoft Store durable release order', () => {
  it('selects the older version even when newer qualification finishes first', () => {
    const newer = { ...request, runNumber: 124 }
    const older = request
    expect(nextStoreRelease([newer, older], [])).toBe(older)
    expect(nextStoreRelease([newer, older], [{ run_number: 122, status: 'in_progress' }])).toBeUndefined()
    expect(nextStoreRelease([newer, older], [{ run_number: 123, status: 'queued' }])).toBeUndefined()
    expect(nextStoreRelease([], [])).toBeUndefined()
  })

  it.each([
    { ...request, runNumber: 124 }, { ...request, runId: 'bad' }, { ...request, tag: '--help' },
    { ...request, commit: 'branch-sha' }, { ...request, packages: request.packages.slice(0, 1) },
    { ...request, packages: request.packages.map(item => ({ ...item, name: '../outside.appx' })) },
    { ...request, packages: request.packages.map(item => ({ ...item, sha256: 'changed' })) },
  ])('rejects invalid persisted requests before downloads: %j', (value) => {
    expect(() => validateStoreRequest(value)).toThrow()
  })

  it('retains an immutable request when the release run is retried', async () => {
    vi.stubEnv('GITHUB_RUN_ID', request.runId)
    vi.stubEnv('GITHUB_RUN_NUMBER', String(request.runNumber))
    vi.stubEnv('RELEASE_TAG', request.tag)
    vi.stubEnv('RELEASE_COMMIT', request.commit)
    vi.stubEnv('STORE_VERSION', request.version)
    await temporary(async (root) => {
      const packages = join(root, 'qualified')
      await mkdir(packages)
      for (const item of request.packages) await writeFile(join(packages, item.name), 'rebuilt bytes')
      const api = github()
      await expect(enqueueStoreRelease(root, api.run, packages)).resolves.toContain('already queued')
      expect(api.uploaded).toEqual([])
    })
  })

  it('persists both package assets before making the request visible to the dispatcher', async () => {
    vi.stubEnv('GITHUB_RUN_ID', request.runId)
    vi.stubEnv('GITHUB_RUN_NUMBER', String(request.runNumber))
    vi.stubEnv('RELEASE_TAG', request.tag)
    vi.stubEnv('RELEASE_COMMIT', request.commit)
    vi.stubEnv('STORE_VERSION', request.version)
    await temporary(async (root) => {
      const packages = join(root, 'qualified')
      await mkdir(packages)
      for (const [index, item] of request.packages.entries()) await writeFile(join(packages, item.name), index === 0 ? 'x64' : 'arm64')
      const api = github()
      const run = vi.fn(async (args: string[]) => args[1]?.endsWith('/releases/1/assets?per_page=100') ? '[[]]' : api.run(args))
      await expect(enqueueStoreRelease(root, run, packages)).resolves.toContain('Queued Store release')
      expect(api.uploaded.map(item => item.name)).toEqual([...request.packages.map(item => item.name), 'store-request-123.json'])
      expect(JSON.parse(api.uploaded[2]?.content ?? '')).toEqual(request)
    })
  })

  it('rejects an undeployed default-branch dispatcher before uploading queue assets', async () => {
    vi.stubEnv('GITHUB_RUN_ID', request.runId)
    vi.stubEnv('GITHUB_RUN_NUMBER', String(request.runNumber))
    vi.stubEnv('RELEASE_TAG', request.tag)
    vi.stubEnv('RELEASE_COMMIT', request.commit)
    vi.stubEnv('STORE_VERSION', request.version)
    await temporary(async (root) => {
      const packages = join(root, 'qualified')
      await mkdir(packages)
      for (const item of request.packages) await writeFile(join(packages, item.name), '')
      const api = github()
      const run = vi.fn(async (args: string[]) => {
        if (args[1]?.includes('/contents/')) throw new Error('Not found')
        return api.run(args)
      })
      await expect(enqueueStoreRelease(root, run, packages)).rejects.toThrow('Deploy Desktop Store queue')
      expect(api.uploaded).toEqual([])
    })
  })

  it('recovers across dispatches from certification to publication through the real publisher', async () => {
    await temporary(async (root) => {
      const identity = { productId: 'store', identityName: 'test.app', publisher: 'CN=test' }
      await writeFile(join(root, 'windows-store.json'), JSON.stringify(identity))
      let processing = true
      const cli = vi.fn(async (args: string[]) => {
        if (args[0] === 'apps') return JSON.stringify({
          Id: identity.productId, PackageIdentityName: identity.identityName, PublisherName: identity.publisher,
          PendingApplicationSubmission: processing ? { Id: 'submission' } : null,
          LastPublishedApplicationSubmission: { Id: 'submission' },
        })
        if (args[0] === 'submission' && args[1] === 'get') return JSON.stringify({
          Id: 'submission', Status: processing ? 'Certification' : 'Published',
          ApplicationPackages: request.packages.map((item, index) => ({
            FileName: item.name, Version: request.version, Architecture: index === 0 ? 'X64' : 'ARM64', FileStatus: 'Uploaded',
          })),
        })
        throw new Error('Unexpected Partner Center write during recovery')
      })
      const submit: typeof publishWindowsStore = (application, version, directory, payload) => (
        publishWindowsStore(application, version, directory, payload, cli)
      )
      const api = github()
      const verify = vi.fn(async () => ({ stdout: '', stderr: '' }))
      const first = join(root, 'first')
      const second = join(root, 'second')
      await mkdir(first)
      await mkdir(second)
      await expect(dispatchStoreRelease(first, api.run, verify, submit, root)).resolves.toContain('deferred')
      expect(api.uploaded).toEqual([])
      processing = false
      await expect(dispatchStoreRelease(second, api.run, verify, submit, root)).resolves.toContain('already-published')
      expect(api.uploaded.map(item => item.name)).toEqual(['store-published-123.json'])
      expect(cli).toHaveBeenCalledTimes(4)
    })
  })

  it.each(['submitted', 'deferred', 'already-published'] as const)('retains the request until actual publication: %s', async (status) => {
    await temporary(async (root) => {
      const api = github()
      const verify = vi.fn(async () => ({ stdout: '', stderr: '' }))
      const submit = vi.fn(async () => ({ status, submissionId: 'submission' }))
      await expect(dispatchStoreRelease(root, api.run, verify, submit, root)).resolves.toContain(status)
      expect(verify).toHaveBeenCalledTimes(2)
      expect(submit.mock.calls).toHaveLength(1)
      expect(JSON.parse(await readFile(join(root, 'windows-store.json'), 'utf8'))).toMatchObject({ version: request.version })
      expect(api.uploaded.map(item => item.name)).toEqual(status === 'already-published' ? ['store-published-123.json'] : [])
      expect(api.run.mock.calls[0]?.[0][1]).toContain('/actions/workflows/desktop-release.yml/runs')
    })
  })

  it('returns during older qualification without contacting Partner Center', async () => {
    await temporary(async (root) => {
      const api = github({ active: true })
      const verify = vi.fn()
      const submit = vi.fn()
      await expect(dispatchStoreRelease(root, api.run, verify, submit, root)).resolves.toContain('deferred')
      expect(verify).not.toHaveBeenCalled()
      expect(submit).not.toHaveBeenCalled()
    })
  })

  it('does not resubmit a release with a durable publication receipt', async () => {
    await temporary(async (root) => {
      const api = github({ complete: true })
      const submit = vi.fn()
      await expect(dispatchStoreRelease(root, api.run, vi.fn(), submit, root)).resolves.toBe('No queued Store releases.')
      expect(submit).not.toHaveBeenCalled()
    })
  })

  it.each([
    [{ corrupt: true }, 'digest changed'], [{ moved: true }, 'tag moved'], [{ incompleteHistory: true }, 'Incomplete Desktop release history'],
  ])('stops corrupted or incomplete release inputs before submission: %j', async (options, message) => {
    await temporary(async (root) => {
      const api = github(options)
      const submit = vi.fn()
      await expect(dispatchStoreRelease(root, api.run, vi.fn(), submit, root)).rejects.toThrow(message)
      expect(submit).not.toHaveBeenCalled()
      expect(api.uploaded).toEqual([])
    })
  })

  it('retains the request after verification or Partner Center failure', async () => {
    await temporary(async (root) => {
      const api = github()
      const submit = vi.fn(async () => { throw new Error('certification failed') })
      await expect(dispatchStoreRelease(root, api.run, vi.fn(async () => ({ stdout: '', stderr: '' })), submit, root)).rejects.toThrow('certification failed')
      expect(api.uploaded).toEqual([])
    })
  })
})
