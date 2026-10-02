/** Verified build-time downloads and extraction for Desktop runtime assets. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import extractZip from 'extract-zip'
import { extract as extractTar, list as listTar } from 'tar'

export const ELECTRON_ROOT = resolve(import.meta.dirname, '../..')
export const BUILD_ROOT = join(ELECTRON_ROOT, '.electron-build')
export const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']

export function target() {
  const platform = process.env.DSH_ELECTRON_TARGET_PLATFORM ?? process.platform
  const arch = process.env.DSH_ELECTRON_TARGET_ARCH ?? process.arch
  const name = `${platform}-${arch}`
  if (!TARGETS.includes(name)) throw new Error(`desktop toolchains: unsupported target ${name}`)
  return name
}

async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifiedArchive(entry) {
  const downloads = join(BUILD_ROOT, 'downloads')
  mkdirSync(downloads, { recursive: true })
  const filename = basename(new URL(entry.url).pathname)
  const path = join(downloads, `${entry.sha256}-${filename}`)
  if (existsSync(path) && await digest(path) === entry.sha256) return path
  rmSync(path, { force: true })
  const pending = `${path}.${process.pid}.pending`
  try {
    const response = await fetch(entry.url)
    if (!response.ok || response.body === null || new URL(response.url).protocol !== 'https:') {
      throw new Error(`download failed: ${entry.url} (${response.status})`)
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(pending, { mode: 0o600 }))
    if (await digest(pending) !== entry.sha256) throw new Error(`SHA256 mismatch: ${entry.url}`)
    renameSync(pending, path)
    return path
  } finally {
    rmSync(pending, { force: true })
  }
}

function safeMember(name) {
  const parts = name.replaceAll('\\', '/').split('/')
  if (isAbsolute(name) || /^[A-Za-z]:/u.test(name) || parts.includes('..') || parts[0] === '') {
    throw new Error(`unsafe toolchain archive member: ${name}`)
  }
  return parts.slice(1).join('/')
}

function safeLink(member, link) {
  const stripped = safeMember(member)
  if (isAbsolute(link.replaceAll('\\', '/')) || /^[A-Za-z]:/u.test(link)) throw new Error(`unsafe toolchain archive link: ${member}`)
  const resolved = normalize(join(dirname(stripped), link.replaceAll('\\', '/')))
  if (resolved === '..' || resolved.startsWith(`..${sep}`)) throw new Error(`unsafe toolchain archive link: ${member}`)
}

export function validateArchiveMember(name, link) {
  safeMember(name)
  if (link !== undefined) safeLink(name, link)
}

export async function extractArchive(archive, entry, destination) {
  mkdirSync(destination, { recursive: true })
  if (entry.archive !== 'tar.gz') throw new Error(`unsupported archive: ${entry.archive}`)
  const members = []
  const links = new Map()
  let invalid
  await listTar({ file: archive, strict: true, onReadEntry: member => {
    try {
    const name = safeMember(member.path)
    members.push(name)
    if (member.type === 'SymbolicLink') links.set(name, member.linkpath.replaceAll('\\', '/'))
    validateArchiveMember(member.path)
    if (!['File', 'Directory', 'SymbolicLink'].includes(member.type)) throw new Error(`unsupported toolchain member type: ${member.type}`)
    if (member.type === 'Link') throw new Error(`unsupported toolchain hard link: ${member.path}`)
    if (member.type === 'SymbolicLink') validateArchiveMember(member.path, member.linkpath)
    } catch (error) { invalid ??= error }
  } })
  if (invalid !== undefined) throw invalid

  for (const member of members) {
    const parts = member.split('/')
    for (let count = 1; count < parts.length; count++) {
      if (links.has(parts.slice(0, count).join('/'))) throw new Error(`archive member traverses a symlink: ${member}`)
    }
  }
  for (const [name, link] of links) {
    const pending = [...dirname(name).split('/').filter(part => part !== '.'), ...link.split('/')]
    const resolved = []
    let expansions = 0
    while (pending.length > 0) {
      const part = pending.shift()
      if (part === '' || part === '.') continue
      if (part === '..') {
        if (resolved.length === 0) throw new Error(`unsafe toolchain symlink chain: ${name}`)
        resolved.pop()
        continue
      }
      resolved.push(part)
      const linked = links.get(resolved.join('/'))
      if (linked !== undefined) {
        if (++expansions > 64) throw new Error(`cyclic toolchain symlink: ${name}`)
        resolved.pop()
        pending.unshift(...linked.split('/'))
      }
    }
  }
  await extractTar({ file: archive, cwd: destination, strip: 1, strict: true, preservePaths: false, filter: member => safeMember(member).length > 0 })
}

export function run(executable, args, expected) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true })
  if (result.error !== undefined || result.status !== 0 || (expected !== undefined && result.stdout.trim() !== expected)) {
    throw new Error(`toolchain executable failed: ${executable} ${args.join(' ')}: ${result.error?.message ?? result.stderr.trim() ?? String(result.status)}`)
  }
}

export function prepared(runtime, targetName, entry, executable) {
  const destination = join(BUILD_ROOT, 'toolchains', runtime, targetName)
  const marker = join(destination, '.verified-sha256')
  if (existsSync(executable(destination)) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === entry.sha256) return destination
  return undefined
}

export async function prepare(runtime, targetName, entry, executable, verify) {
  const cached = prepared(runtime, targetName, entry, executable)
  if (cached !== undefined) return cached
  const archive = await verifiedArchive(entry)
  const root = join(BUILD_ROOT, 'toolchains', runtime)
  const destination = join(root, targetName)
  const staged = join(root, `${targetName}.${process.pid}.pending`)
  rmSync(staged, { recursive: true, force: true })
  try {
    mkdirSync(staged, { recursive: true })
    await unpackRuntime(archive, entry, join(staged, 'runtime'))
    const runtimeRoot = join(staged, 'runtime')
    if (!existsSync(executable(runtimeRoot))) throw new Error(`missing ${runtime} executable in ${entry.url}`)
    if (`${process.platform}-${process.arch}` === targetName) verify(runtimeRoot)
    writeFileSync(join(runtimeRoot, '.verified-sha256'), `${entry.sha256}\n`)
    rmSync(destination, { recursive: true, force: true })
    renameSync(runtimeRoot, destination)
    return destination
  } finally {
    rmSync(staged, { recursive: true, force: true })
  }
}

export function updateCurrent(runtime, preparedRoot, entry) {
  const root = join(BUILD_ROOT, 'toolchains', 'current')
  mkdirSync(root, { recursive: true })
  const destination = join(root, runtime)
  if (existsSync(join(destination, '.verified-sha256'))
    && readFileSync(join(destination, '.verified-sha256'), 'utf8').trim() === entry.sha256
    && !hasAbsoluteLink(destination)) return
  const staged = join(root, `${runtime}.${process.pid}.pending`)
  const old = join(root, `${runtime}.${process.pid}.old`)
  rmSync(staged, { recursive: true, force: true })
  rmSync(old, { recursive: true, force: true })
  try {
    // The packaging path changes only after the complete copy and executable checks succeed.
    cpSync(preparedRoot, staged, { recursive: true, verbatimSymlinks: true })
    if (!existsSync(join(staged, '.verified-sha256'))) throw new Error(`incomplete ${runtime} runtime`)
    if (hasAbsoluteLink(staged)) throw new Error(`toolchain copy contains absolute symlinks: ${runtime}`)
    if (existsSync(destination)) renameSync(destination, old)
    try { renameSync(staged, destination) } catch (error) {
      if (existsSync(old)) renameSync(old, destination)
      throw error
    }
  } finally {
    rmSync(staged, { recursive: true, force: true })
    rmSync(old, { recursive: true, force: true })
  }
}

function hasAbsoluteLink(root) {
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() && isAbsolute(readlinkSync(path))) return true
      if (stat.isDirectory()) pending.push(path)
    }
  }
  return false
}

/** Shared secure extraction used by Main and build preparation. */
export async function unpackRuntime(archive, entry, destination) {
  if (entry.archive !== 'zip') return await extractArchive(archive, entry, destination)
  const extracted = `${destination}.zip`
  try {
    await extractZip(archive, { dir: resolve(extracted), onEntry: member => {
      validateArchiveMember(member.fileName)
      const mode = (member.externalFileAttributes >> 16) & 0xFFFF
      if ((mode & 0o170000) === 0o120000) throw new Error(`unsupported toolchain ZIP symlink: ${member.fileName}`)
    } })
    const folder = basename(new URL(entry.url).pathname, '.zip')
    renameSync(join(extracted, folder), destination)
  } finally {
    rmSync(extracted, { recursive: true, force: true })
  }
}
