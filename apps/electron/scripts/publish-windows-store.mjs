/** Submit qualified AppX packages through the pinned Microsoft Store Developer CLI. */
import { execFile } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Upload both architectures, retain listing metadata, and commit an Immediate submission.
 * Return after commit acceptance; Partner Center continues ingestion, certification, and publication.
 * Existing pending submissions and older package versions fail before any remote writes.
 * @param {{ productId: string, identityName: string, publisher: string }} identity Expected Partner Center application.
 * @param {string} version Qualified Store package version.
 * @param {string} packageDirectory Directory containing exactly the x64 and ARM64 AppX files.
 * @param {string} payloadPath Private runner-local path for submission metadata (contains an upload SAS).
 * @param {(args: string[]) => Promise<string>} [run] Microsoft CLI command executor.
 * @returns {Promise<{ status: 'submitted' | 'already-published', submissionId: string }>} Submission receipt; certification continues in Partner Center.
 */
export async function publishWindowsStore(identity, version, packageDirectory, payloadPath, run = runStoreCli) {
  const expected = ['x64', 'arm64'].map(arch => `Rivetdeck-store-${version}-${arch}.appx`)
  const entries = await readdir(packageDirectory, { withFileTypes: true })
  if (entries.length !== 2 || entries.some(entry => !entry.isFile() || !expected.includes(entry.name))) {
    throw new Error('Store submission requires exactly the qualified x64 and ARM64 AppX packages')
  }
  const target = versionParts(version)
  const app = parseRecord(await run(['apps', 'get', identity.productId]))
  if (app.Id !== identity.productId || app.PackageIdentityName !== identity.identityName || app.PublisherName !== identity.publisher) {
    throw new Error('Partner Center application identity differs from windows-store.json')
  }
  if (app.PendingApplicationSubmission !== null) {
    throw new Error('Partner Center has a pending submission; finish or remove it before retrying this release')
  }
  const publishedId = submissionId(app.LastPublishedApplicationSubmission)
  const published = parseRecord(await run(['submission', 'get', identity.productId]))
  if (published.Id !== publishedId) throw new Error('Partner Center published submission changed during release validation')
  const publishedPackages = packageRecords(published)
  if (['x64', 'arm64'].every(arch => publishedPackages.some(item => typeof item.Architecture === 'string' && item.Architecture.toLowerCase() === arch && item.Version === version))) {
    return { status: 'already-published', submissionId: publishedId }
  }
  for (const item of publishedPackages) {
    const previous = versionParts(item.Version)
    const difference = previous.map((part, index) => part - target[index]).find(part => part !== 0) ?? 0
    if (difference >= 0) throw new Error('Store package version must exceed every published package version')
  }

  // The CLI's publish command replaces pending drafts; recheck just before calling it.
  const current = parseRecord(await run(['apps', 'get', identity.productId]))
  if (current.PendingApplicationSubmission !== null || submissionId(current.LastPublishedApplicationSubmission) !== publishedId) {
    throw new Error('Partner Center submission changed before upload; retry after resolving the pending submission')
  }
  await run(['publish', project, '--appId', identity.productId, '--inputDirectory', packageDirectory, '--noCommit'])
  const uploaded = parseRecord(await run(['apps', 'get', identity.productId]))
  const pendingId = submissionId(uploaded.PendingApplicationSubmission)
  const draft = parseRecord(await run(['submission', 'get', identity.productId]))
  if (draft.Id !== pendingId || draft.Id === publishedId) throw new Error('Microsoft Store CLI did not create the expected draft')
  const packages = packageRecords(draft)
  for (const name of expected) {
    if (packages.filter(item => item.FileName === name && item.FileStatus === 'PendingUpload').length !== 1) {
      throw new Error(`Store draft is missing uploaded package ${name}`)
    }
  }
  // Remove every predecessor architecture; the CLI replaces only the first matching extension.
  for (const item of packages) {
    if (!expected.includes(item.FileName)) item.FileStatus = 'PendingDelete'
  }
  draft.TargetPublishMode = 'Immediate'
  draft.TargetPublishDate = '1601-01-01T00:00:00Z'
  await writeFile(payloadPath, `${JSON.stringify(draft)}\n`, { mode: 0o600, flag: 'wx' })
  await run(['submission', 'updateMetadata', identity.productId, payloadPath])
  const updated = parseRecord(await run(['submission', 'get', identity.productId]))
  if (updated.Id !== pendingId || updated.TargetPublishMode !== 'Immediate') {
    throw new Error('Store submission ID or automatic publication setting changed before commit')
  }
  const updatedPackages = packageRecords(updated)
  if (updatedPackages.filter(item => item.FileStatus !== 'PendingDelete').length !== 2
    || expected.some(name => !updatedPackages.some(item => item.FileName === name && item.FileStatus === 'PendingUpload'))) {
    throw new Error('Store submission must contain both uploaded architectures before commit')
  }
  await run(['submission', 'publish', identity.productId])
  return { status: 'submitted', submissionId: pendingId }
}

function parseRecord(output) {
  const value = JSON.parse(output)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Microsoft Store CLI JSON object')
  return value
}

function submissionId(value) {
  if (typeof value !== 'object' || value === null || typeof value.Id !== 'string' || value.Id.length === 0) {
    throw new Error('Partner Center requires an initial published submission before automated updates')
  }
  return value.Id
}

function packageRecords(value) {
  if (!Array.isArray(value.ApplicationPackages) || value.ApplicationPackages.length === 0
    || value.ApplicationPackages.some(item => typeof item !== 'object' || item === null || typeof item.FileName !== 'string')) {
    throw new Error('Invalid Microsoft Store CLI application packages')
  }
  return value.ApplicationPackages
}

function versionParts(version) {
  if (typeof version !== 'string' || !/^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/.test(version)) {
    throw new Error('Invalid Microsoft Store package version')
  }
  const parts = version.split('.').map(Number)
  if (parts.some(part => part > 65535)) throw new Error('Microsoft Store package version exceeds 65535')
  return parts
}

async function runStoreCli(args) {
  try {
    const { stdout } = await execute('msstore', args, { maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch (error) {
    // CLI output can contain the submission upload SAS; do not include it in CI errors.
    throw new Error(`Microsoft Store CLI ${args[0]} ${args[1]} failed; inspect the submission in Partner Center`, { cause: typeof error.code === 'number' ? error.code : undefined })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const temporary = await mkdtemp(join(tmpdir(), 'rivetdeck-store-submission-'))
  try {
    const identity = JSON.parse(await readFile(join(project, 'windows-store.json'), 'utf8'))
    const receipt = await publishWindowsStore(identity, process.env.STORE_VERSION ?? '', resolve('dist/electron-store'), join(temporary, 'submission.json'))
    const message = `Microsoft Store ${receipt.status}: ${receipt.submissionId} (${process.env.STORE_VERSION}). Certification and publication status: https://partner.microsoft.com/dashboard/products/${identity.productId}`
    console.log(message)
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`, { flag: 'a' })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
