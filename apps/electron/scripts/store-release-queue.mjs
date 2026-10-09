/** Persist qualified Store releases as GitHub Release assets and dispatch them in version order. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { storeReleaseVersion } from './store-release-version.mjs'
import { publishWindowsStore } from './publish-windows-store.mjs'

const execute = promisify(execFile)
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requestPattern = /^store-request-([1-9]\d*)\.json$/

/**
 * @typedef {object} StoreReleaseRequest
 * @property {string} runId Desktop release source run ID.
 * @property {number} runNumber Desktop release sequence used for the package version.
 * @property {string} tag Validated release tag.
 * @property {string} commit Qualified source commit.
 * @property {string} version Four-part AppX version.
 * @property {{ name: string, sha256: string }[]} packages Both qualified unsigned packages.
 */

/**
 * Select the oldest durable request, deferring while an earlier release is still building.
 * @param {StoreReleaseRequest[]} requests Queued releases without publication receipts.
 * @param {{ run_number: number, status: string }[]} runs Desktop release workflow runs.
 * @returns {StoreReleaseRequest | undefined} Next request, or no eligible work.
 */
export function nextStoreRelease(requests, runs) {
  const next = [...requests].sort((a, b) => a.runNumber - b.runNumber)[0]
  if (next === undefined || runs.some(run => run.run_number <= next.runNumber && run.status !== 'completed')) return undefined
  return next
}

/**
 * Validate persisted request data before it determines downloads, versioning, or commands.
 * @param {unknown} request Decoded GitHub Release asset.
 * @returns {StoreReleaseRequest} Validated request.
 */
export function validateStoreRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)
    || typeof request.runId !== 'string' || !/^[1-9]\d*$/.test(request.runId)
    || !Number.isSafeInteger(request.runNumber)
    || request.version !== storeReleaseVersion(String(request.runNumber))
    || typeof request.tag !== 'string' || !/^v\d+\.\d+\.\d+(?:-beta\.\d+|-rc\.\d+)?$/.test(request.tag)
    || typeof request.commit !== 'string' || !/^[a-f0-9]{40}$/.test(request.commit)
    || !Array.isArray(request.packages) || request.packages.length !== 2) {
    throw new Error('Invalid durable Store release request')
  }
  const expected = ['x64', 'arm64'].map(arch => `Rivetdeck-store-${request.version}-${arch}.appx`)
  for (const name of expected) {
    if (request.packages.filter(item => item !== null && typeof item === 'object' && item.name === name
      && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)).length !== 1) {
      throw new Error('Store request requires both package names and SHA256 digests')
    }
  }
  return request
}

async function packageDigest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function gh(args) {
  const { stdout } = await execute('gh', args, { maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60 * 1000 })
  return stdout
}

async function pages(endpoint, run = gh) {
  return JSON.parse(await run(['api', endpoint, '--paginate', '--slurp']))
}

async function assets(releaseId, run = gh) {
  return (await pages(`repos/${process.env.GH_REPO}/releases/${releaseId}/assets?per_page=100`, run)).flat()
}

async function assetJson(asset, run = gh) {
  return JSON.parse(await run(['api', `repos/${process.env.GH_REPO}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream']))
}

async function uploadJson(tag, name, value, temporary, run = gh) {
  const path = join(temporary, name)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  await run(['release', 'upload', tag, path])
}

async function requireStoreDispatcher(run = gh) {
  const defaultBranch = (await run(['api', `repos/${process.env.GH_REPO}`, '--jq', '.default_branch'])).trim()
  try {
    await run(['api', `repos/${process.env.GH_REPO}/contents/.github/workflows/desktop-store-queue.yml?ref=${encodeURIComponent(defaultBranch)}`])
  } catch (error) {
    throw new Error('Deploy Desktop Store queue to the repository default branch before queuing Store releases', { cause: error })
  }
  const workflow = JSON.parse(await run(['api', `repos/${process.env.GH_REPO}/actions/workflows/desktop-store-queue.yml`]))
  if (workflow.state !== 'active') throw new Error('Enable Desktop Store queue on the repository default branch before queuing Store releases')
  return 'Desktop Store queue is deployed and enabled on the repository default branch.'
}

/**
 * Save packages first and an immutable request last; retries retain the first qualified bytes.
 * @param {string} temporary Private directory for the request file.
 * @param {typeof gh} [run] GitHub command executor.
 * @param {string} [packageDirectory] Qualified unsigned AppX directory.
 * @returns {Promise<string>} Queue acknowledgement.
 */
export async function enqueueStoreRelease(temporary, run = gh, packageDirectory = resolve('dist/electron-store')) {
  const request = validateStoreRequest({
    runId: process.env.GITHUB_RUN_ID,
    runNumber: Number(process.env.GITHUB_RUN_NUMBER),
    tag: process.env.RELEASE_TAG,
    commit: process.env.RELEASE_COMMIT,
    version: storeReleaseVersion(process.env.GITHUB_RUN_NUMBER ?? ''),
    packages: await Promise.all(['x64', 'arm64'].map(async arch => {
      const name = `Rivetdeck-store-${process.env.STORE_VERSION}-${arch}.appx`
      return { name, sha256: await packageDigest(join(packageDirectory, name)) }
    })),
  })
  await requireStoreDispatcher(run)
  const release = JSON.parse(await run(['api', `repos/${process.env.GH_REPO}/releases/tags/${request.tag}`]))
  if (release.draft) throw new Error('Store requests require a published GitHub Release')
  const existing = await assets(release.id, run)
  const name = `store-request-${request.runNumber}.json`
  const prior = existing.find(asset => asset.name === name)
  if (prior !== undefined) {
    const recorded = validateStoreRequest(await assetJson(prior, run))
    if (recorded.runId !== request.runId || recorded.commit !== request.commit || recorded.tag !== request.tag) {
      throw new Error('Store request already belongs to a different release')
    }
    return `Store release ${request.version} is already queued; its original qualified packages are retained.`
  }
  // The request is the commit marker: the dispatcher ignores partial uploads.
  for (const item of request.packages) await run(['release', 'upload', request.tag, join(packageDirectory, item.name), '--clobber'])
  await uploadJson(request.tag, name, request, temporary, run)
  return `Queued Store release ${request.version} (${request.tag}); Desktop Store queue submits it after earlier releases and Partner Center publication.`
}

/**
 * Advance one release without waiting on Store certification; publication writes a durable receipt.
 * @param {string} temporary Private download and metadata directory.
 * @param {typeof gh} [run] GitHub command executor.
 * @param {typeof execute} [verify] Native package verification executor.
 * @param {typeof publishWindowsStore} [submit] Partner Center publisher.
 * @param {string} [projectDirectory] Electron application with Store identity and verifier.
 * @returns {Promise<string>} Publication, submission, or deferral status.
 */
export async function dispatchStoreRelease(temporary, run = gh, verify = execute, submit = publishWindowsStore, projectDirectory = project) {
  // Runs precede asset discovery: a completed source has already persisted its request.
  const runPages = await pages(`repos/${process.env.GH_REPO}/actions/workflows/desktop-release.yml/runs?per_page=100`, run)
  const runs = runPages.flatMap(page => page.workflow_runs)
  if (runs.length !== runPages[0]?.total_count) throw new Error('Incomplete Desktop release history; cannot establish Store order')
  const releases = (await pages(`repos/${process.env.GH_REPO}/releases?per_page=100`, run)).flat()
  const requests = []
  for (const release of releases) {
    if (release.draft) continue
    const releaseAssets = await assets(release.id, run)
    for (const asset of releaseAssets) {
      const match = requestPattern.exec(asset.name)
      if (match === null) continue
      const publication = releaseAssets.find(item => item.name === `store-published-${match[1]}.json`)
      const request = validateStoreRequest(await assetJson(asset, run))
      if (String(request.runNumber) !== match[1] || request.tag !== release.tag_name) throw new Error('Store request does not match its release asset')
      if (publication !== undefined) {
        const receipt = await assetJson(publication, run)
        if (receipt.status !== 'already-published' || receipt.version !== request.version || receipt.runId !== request.runId
          || typeof receipt.submissionId !== 'string' || receipt.submissionId.length === 0) throw new Error('Invalid Store publication receipt')
        continue
      }
      requests.push(request)
    }
  }
  if (requests.length === 0) return 'No queued Store releases.'
  if (new Set(requests.map(request => request.runNumber)).size !== requests.length) throw new Error('Duplicate Store release run numbers')

  const request = nextStoreRelease(requests, runs)
  if (request === undefined) return 'Store queue deferred while an earlier Desktop release finishes.'
  const tagCommit = (await run(['api', `repos/${process.env.GH_REPO}/commits/${request.tag}`, '--jq', '.sha'])).trim()
  if (tagCommit !== request.commit) throw new Error('Store release tag moved after qualification')
  const directory = join(temporary, 'packages')
  await mkdir(directory)
  for (const item of request.packages) {
    await run(['release', 'download', request.tag, '--pattern', item.name, '--dir', directory])
    if (await packageDigest(join(directory, item.name)) !== item.sha256) {
      throw new Error(`Qualified Store package digest changed: ${item.name}`)
    }
  }
  const identity = JSON.parse(await readFile(join(projectDirectory, 'windows-store.json'), 'utf8'))
  await writeFile(join(projectDirectory, 'windows-store.json'), `${JSON.stringify({ ...identity, version: request.version }, null, 2)}\n`)
  for (const arch of ['x64', 'arm64']) {
    await verify('pwsh', ['-NoProfile', '-File', join(projectDirectory, 'scripts/verify-windows-store.ps1'),
      '-PackagePath', join(directory, `Rivetdeck-store-${request.version}-${arch}.appx`), '-Architecture', arch], { timeout: 5 * 60 * 1000 })
  }
  const receipt = await submit(identity, request.version, directory, join(temporary, 'submission.json'))
  if (receipt.status === 'already-published') {
    await uploadJson(request.tag, `store-published-${request.runNumber}.json`, { ...receipt, version: request.version, runId: request.runId }, temporary, run)
  }
  return `Store release ${request.version}: ${receipt.status} (${receipt.submissionId}). Remaining requests stay queued until publication. https://partner.microsoft.com/dashboard/products/${identity.productId}`
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const temporary = await mkdtemp(join(tmpdir(), 'rivetdeck-store-queue-'))
  try {
    let message
    switch (process.argv[2]) {
      case 'check': message = await requireStoreDispatcher(); break
      case 'enqueue': message = await enqueueStoreRelease(temporary); break
      case 'dispatch': message = await dispatchStoreRelease(temporary); break
      default: throw new Error('Usage: store-release-queue.mjs check|enqueue|dispatch')
    }
    console.log(message)
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`, { flag: 'a' })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
