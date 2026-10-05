import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { create as tar } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { installRuntime, verifyRuntime } from '../src/toolchains/installer.ts'
import { RuntimeManager } from '../src/toolchains/manager.ts'
import { runtimePaths } from '../src/toolchains/paths.ts'
import { loadManifest } from '../scripts/toolchains/manifest.mjs'
import { readPendingRuntimeInstallation, readRuntimeReceipt, receiptLocation } from '../src/toolchains/resolver.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) })) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-install-'))
  roots.push(root)
  await mkdir(join(root, 'source', 'runtime', 'bin'), { recursive: true })
  await writeFile(join(root, 'source', 'runtime', 'bin', 'interpreter'), 'runtime')
  const archive = join(root, 'fixture.tar.gz')
  await tar({ cwd: join(root, 'source'), file: archive, gzip: true }, ['runtime'])
  const bytes = await readFile(archive)
  const entry = { url: 'https://nodejs.org/fixture.tar.gz', sha256: createHash('sha256').update(bytes).digest('hex'), archive: 'tar.gz' }
  return { root, bytes, entry }
}

describe('Main runtime installer', () => {
  for (const name of ['node', 'python'] as const) {
    it(`atomically installs verified ${name} and cleans staging`, async () => {
      const { root, bytes, entry } = await fixture()
      const phases: string[] = []
      const destination = join(root, 'installed')
      await installRuntime({ name, version: '1.2.3', entry, staging: join(root, 'staging'), destination, platform: process.platform,
        fetch: async () => new Response(bytes), signal: new AbortController().signal,
        phase: phase => phases.push(phase), verify: async (_name, directory) => {
          expect(await readFile(join(directory, 'bin/interpreter'), 'utf8')).toBe('runtime')
          await expect(readFile(join(destination, 'bin/interpreter'))).rejects.toThrow()
        },
      })
      expect(phases).toContain('verifying')
      expect(phases).toContain('installing')
      expect(await readFile(join(destination, 'bin/interpreter'), 'utf8')).toBe('runtime')
      await expect(readFile(join(root, 'staging/download.pending'))).rejects.toThrow()
    })
  }
  for (const kind of ['checksum', 'archive', 'verification', 'interrupted', 'download', 'disk'] as const) {
    it(`rejects ${kind} without activating or retaining pending files`, async () => {
      const { root, bytes, entry } = await fixture()
      const abort = new AbortController()
      const invalid = Buffer.from('invalid archive')
      const selectedBytes = kind === 'archive' ? invalid : bytes
      const authority = kind === 'archive' ? { ...entry, sha256: createHash('sha256').update(invalid).digest('hex') }
        : kind === 'checksum' ? { ...entry, sha256: '0'.repeat(64) } : entry
      await expect(installRuntime({ name: 'node', version: '1.2.3', entry: authority, staging: join(root, 'stage'), destination: join(root, 'active'), platform: process.platform,
        fetch: async () => { if (kind === 'interrupted') abort.abort(); return new Response(selectedBytes, { status: kind === 'download' ? 503 : 200 }) }, signal: abort.signal, phase: () => {},
        verify: async () => {
          if (kind === 'verification') throw new Error('bad executable')
          if (kind === 'disk') throw Object.assign(new Error('no disk space'), { code: 'ENOSPC' })
        },
      })).rejects.toMatchObject({ code: kind })
      await expect(readFile(join(root, 'active/bin/interpreter'))).rejects.toThrow()
      await expect(readFile(join(root, 'stage/download.pending'))).rejects.toThrow()
    })
  }
  it('rejects HTTPS downgrade redirects', async () => {
    const { root, entry } = await fixture()
    let requests = 0
    await expect(installRuntime({ name: 'node', version: '1.2.3', entry, staging: join(root, 'stage'), destination: join(root, 'active'), platform: process.platform,
      fetch: async () => { requests++; return new Response(null, { status: 302, headers: { location: 'http://unsafe.test/archive' } }) },
      signal: new AbortController().signal, phase: () => {},
    })).rejects.toMatchObject({ code: 'download' })
    expect(requests).toBe(1)
  })
  it('rejects missing interpreter and a wrong Node version', async () => {
    const { root } = await fixture()
    await expect(verifyRuntime('node', root, '24.17.0', process.platform)).rejects.toThrow(/missing/u)
    const nodeRoot = join(root, 'real')
    const executable = join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'bin/node')
    const npm = join(nodeRoot, process.platform === 'win32' ? 'node_modules/npm/bin' : 'lib/node_modules/npm/bin')
    await mkdir(npm, { recursive: true })
    await mkdir(dirname(executable), { recursive: true })
    await copyFile(process.execPath, executable)
    await chmod(executable, 0o755)
    await writeFile(join(npm, 'npm-cli.js'), '')
    await writeFile(join(npm, 'npx-cli.js'), '')
    await expect(verifyRuntime('node', nodeRoot, '1.0.0', process.platform)).rejects.toThrow(/verification/u)
  })
})

describe('Main runtime manager independence', () => {
  for (const name of ['node', 'python'] as const) {
    it(`retains only Python predecessors across reinstall, update, restart, and removal of ${name}`, async () => {
      const { root, bytes, entry } = await fixture()
      const manifest = structuredClone(loadManifest())
      const target = `${process.platform}-${process.arch}` as keyof typeof manifest.node.targets
      Object.assign(manifest[name].targets[target], entry)
      const options = { userData: root, manifest, fetch: async () => new Response(bytes), verify: async () => {} }
      const managers: RuntimeManager[] = []
      const start = async () => {
        const manager = new RuntimeManager(options)
        managers.push(manager)
        await manager.prepare()
        return manager
      }
      try {
        const first = await start()
        await first.install(name)
        const original = first.state()[name].location!
        await first.install(name)
        const replacement = first.state()[name].location!
        await first.shutdown()
        const second = await start()
        if (name === 'python') {
          expect(await readFile(join(original, 'bin/interpreter'), 'utf8')).toBe('runtime')
          expect(readRuntimeReceipt(join(root, 'managed-toolchains'), name)?.retired).toHaveLength(1)
        } else {
          await expect(readFile(join(original, 'bin/interpreter'))).rejects.toMatchObject({ code: 'ENOENT' })
        }
        manifest[name].version = '9.9.9'
        await second.shutdown()
        const updating = await start()
        await updating.install(name)
        const current = updating.state()[name].location!
        await updating.shutdown()
        const third = await start()
        if (name === 'python') {
          expect(await readFile(join(original, 'bin/interpreter'), 'utf8')).toBe('runtime')
          expect(await readFile(join(replacement, 'bin/interpreter'), 'utf8')).toBe('runtime')
          expect(readRuntimeReceipt(join(root, 'managed-toolchains'), name)?.retired).toHaveLength(2)
        } else {
          await expect(readFile(join(replacement, 'bin/interpreter'))).rejects.toMatchObject({ code: 'ENOENT' })
        }
        await third.remove(name)
        expect(await readFile(join(current, 'bin/interpreter'), 'utf8')).toBe('runtime')
        await third.shutdown()
        const removed = await start()
        expect(removed.state()[name].phase).toBe('not-installed')
        for (const location of [original, replacement, current]) {
          await expect(readFile(join(location, 'bin/interpreter'))).rejects.toMatchObject({ code: 'ENOENT' })
        }
      } finally { await Promise.all(managers.map(manager => manager.shutdown())) }
    })
  }
  for (const name of ['node', 'python'] as const) {
    for (const selection of ['absent', 'installed', 'update-available', 'committed'] as const) {
      it(`recovers interrupted ${name} installation with ${selection} active selection`, async () => {
        const { root } = await fixture()
        const managed = join(root, 'managed-toolchains')
        const target = `${process.platform}-${process.arch}`
        const lockVersion = loadManifest()[name].version
        const pending = { version: '1.2.3', generation: 'a'.repeat(36), target: selection === 'committed' ? target : 'win32-arm64' }
        const destination = receiptLocation(managed, name, pending.target, pending)
        await mkdir(destination, { recursive: true })
        await writeFile(join(destination, 'interpreter'), 'pending runtime')
        await writeFile(join(managed, name, 'installation.pending'), JSON.stringify(pending))
        const receipt = {
          version: selection === 'installed' ? lockVersion : selection === 'committed' ? pending.version : '0.9.0',
          generation: selection === 'committed' ? pending.generation : 'b'.repeat(36),
          sha256: 'c'.repeat(64), pendingRemoval: false, retired: [],
        }
        const active = receiptLocation(managed, name, target, receipt)
        if (selection !== 'absent') {
          await mkdir(active, { recursive: true })
          await writeFile(join(active, 'interpreter'), 'active runtime')
          await writeFile(join(managed, name, 'active.json'), JSON.stringify(receipt))
        }
        await mkdir(join(managed, 'staging'), { recursive: true })
        await writeFile(join(managed, 'staging', 'download.pending'), 'partial download')
        const manager = new RuntimeManager({ userData: root, verify: async () => {},
          fetch: async () => { throw new Error('unexpected download') } })
        try {
          const started = await manager.prepare()
          if (selection === 'absent') {
            expect(started).toEqual({})
            expect(manager.state()[name]).toMatchObject({ phase: 'failed', error: 'interrupted' })
          } else if (selection === 'committed') {
            expect(started).toEqual(runtimePaths(name, active, receipt.version, process.platform))
            expect(await readFile(join(destination, 'interpreter'), 'utf8')).toBe('active runtime')
            expect(manager.state()[name].error).toBeUndefined()
          } else {
            expect(started).toEqual(runtimePaths(name, active, receipt.version, process.platform))
            expect(manager.state()[name]).toMatchObject({
              phase: selection, error: 'interrupted', restartRequired: false,
              installedVersion: receipt.version, location: active,
            })
            await expect(readFile(join(destination, 'interpreter'))).rejects.toMatchObject({ code: 'ENOENT' })
          }
          if (selection !== 'absent') {
            expect(await readFile(join(active, 'interpreter'), 'utf8')).toBe('active runtime')
            expect(await readFile(join(managed, name, 'active.json'), 'utf8')).toContain(receipt.generation)
            expect(readRuntimeReceipt(managed, name)).toEqual(receipt)
          }
          await expect(readFile(join(managed, name, 'installation.pending'))).rejects.toMatchObject({ code: 'ENOENT' })
          await expect(readFile(join(managed, 'staging', 'download.pending'))).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
          await manager.shutdown()
        }
      })
    }
    it(`keeps corrupt ${name} when an interrupted update fails verification`, async () => {
      const { root } = await fixture()
      const managed = join(root, 'managed-toolchains')
      const target = `${process.platform}-${process.arch}`
      const pending = { version: '1.2.3', generation: 'a'.repeat(36), target: 'win32-arm64' }
      const destination = receiptLocation(managed, name, pending.target, pending)
      await mkdir(destination, { recursive: true })
      await writeFile(join(destination, 'interpreter'), 'pending runtime')
      await writeFile(join(managed, name, 'installation.pending'), JSON.stringify(pending))
      const receipt = { version: '0.9.0', generation: 'b'.repeat(36), sha256: 'c'.repeat(64), pendingRemoval: false, retired: [] }
      const active = receiptLocation(managed, name, target, receipt)
      await mkdir(active, { recursive: true })
      await writeFile(join(active, 'interpreter'), 'active runtime')
      await writeFile(join(managed, name, 'active.json'), JSON.stringify(receipt))
      const manager = new RuntimeManager({
        userData: root, verify: async () => { throw new Error('damaged executable') },
        fetch: async () => { throw new Error('unexpected download') },
      })
      try {
        expect(await manager.prepare()).toEqual({})
        expect(manager.state()[name]).toMatchObject({ phase: 'failed', error: 'corrupt' })
        expect(await readFile(join(active, 'interpreter'), 'utf8')).toBe('active runtime')
        expect(readRuntimeReceipt(managed, name)).toEqual(receipt)
      } finally {
        await manager.shutdown()
      }
    })
  }
  it('supports Python alone and reports a pinned update without downloading it', async () => {
    const { root, bytes, entry } = await fixture()
    const manifest = structuredClone(loadManifest())
    const target = `${process.platform}-${process.arch}` as keyof typeof manifest.node.targets
    Object.assign(manifest.python.targets[target], entry)
    const options = { userData: root, manifest, fetch: async () => {
      const pending = readPendingRuntimeInstallation(join(root, 'managed-toolchains'), 'python')
      expect(pending).toMatchObject({ version: manifest.python.version, target })
      expect(pending?.generation).toMatch(/^[a-f0-9-]{36}$/u)
      return new Response(bytes)
    }, verify: async () => {} }
    const manager = new RuntimeManager(options)
    await manager.prepare()
    await manager.install('python')
    await manager.shutdown()
    const newer = structuredClone(manifest)
    newer.python.version = '3.99.0'
    const updated = new RuntimeManager({ ...options, manifest: newer, fetch: async () => { throw new Error('unexpected automatic download') } })
    expect(Object.keys(await updated.prepare())).toEqual(['python'])
    expect(updated.state().python).toMatchObject({ phase: 'update-available', installedVersion: manifest.python.version, version: '3.99.0' })
    await updated.shutdown()
    const corrupt = new RuntimeManager({ ...options, verify: async () => { throw new Error('damaged executable') } })
    expect(await corrupt.prepare()).toEqual({})
    expect(corrupt.state().python).toMatchObject({ phase: 'failed', error: 'corrupt' })
    await corrupt.shutdown()
  })
  it('cancels an in-flight download, drains cleanup, and retries independently', async () => {
    const { root, bytes, entry } = await fixture()
    const manifest = structuredClone(loadManifest())
    const target = `${process.platform}-${process.arch}` as keyof typeof manifest.node.targets
    manifest.node.targets[target] = entry
    let entered = (): void => {}
    const downloading = new Promise<void>((resolve) => { entered = resolve })
    let block = true
    const manager = new RuntimeManager({ userData: root, manifest, verify: async () => {}, fetch: async (_url, signal) => {
      if (block) await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('download cancelled')) }, { once: true }); entered() })
      return new Response(bytes)
    } })
    await manager.prepare()
    const install = manager.install('node')
    expect(manager.install('node')).toBe(install)
    await downloading
    expect(manager.state().node.phase).toBe('downloading')
    await manager.cancel('node')
    await install
    expect(manager.state().node).toMatchObject({ phase: 'failed', error: 'interrupted' })
    await expect(readFile(join(root, 'managed-toolchains/node/installation.pending'))).rejects.toThrow()
    block = false
    await manager.install('node')
    expect(manager.state().node.phase).toBe('installed')
    const location = manager.state().node.location!
    await manager.remove('node')
    expect(manager.state().node).toMatchObject({ phase: 'removing', restartRequired: true })
    expect(await readFile(join(location, 'bin/interpreter'), 'utf8')).toBe('runtime')
    await manager.shutdown()
    const restarted = new RuntimeManager({ userData: root, manifest, verify: async () => {}, fetch: async () => { throw new Error('unexpected download') } })
    expect(await restarted.prepare()).toEqual({})
    expect(restarted.state().node.phase).toBe('not-installed')
    await expect(readFile(join(location, 'bin/interpreter'))).rejects.toThrow()
    await restarted.shutdown()
  })
  it('supports zero, Node only, both, deferred removal, and persistent onboarding', async () => {
    const { root, bytes, entry } = await fixture()
    const manifest = structuredClone(loadManifest())
    const target = `${process.platform}-${process.arch}` as keyof typeof manifest.node.targets
    manifest.node.targets[target] = entry
    Object.assign(manifest.python.targets[target], entry)
    const options = { userData: root, manifest, fetch: async () => new Response(bytes), verify: async () => {} }
    const manager = new RuntimeManager(options)
    expect(await manager.prepare()).toEqual({})
    expect(manager.state().onboardingCompleted).toBe(false)
    await manager.completeOnboarding()
    await manager.install('node')
    expect(manager.state().node.phase).toBe('installed')
    expect(manager.state().python.phase).toBe('not-installed')
    await manager.install('python')
    const next = new RuntimeManager(options)
    expect(Object.keys(await next.prepare()).sort()).toEqual(['node', 'python'])
    expect(next.state().onboardingCompleted).toBe(true)
    const location = next.state().node.location!
    await next.remove('node')
    expect(next.state().node).toMatchObject({ phase: 'removing', restartRequired: true })
    expect(await readFile(join(location, 'bin/interpreter'), 'utf8')).toBe('runtime')
    const restarted = new RuntimeManager(options)
    expect(Object.keys(await restarted.prepare())).toEqual(['python'])
    expect(restarted.state().onboardingCompleted).toBe(true)
    await expect(readFile(join(location, 'bin/interpreter'))).rejects.toThrow()
    await restarted.shutdown()
    await next.shutdown()
    await manager.shutdown()
  })
  it('keeps successful Node when Python fails and allows retry in a new generation', async () => {
    const { root, bytes, entry } = await fixture()
    const manifest = structuredClone(loadManifest())
    const target = `${process.platform}-${process.arch}` as keyof typeof manifest.node.targets
    manifest.node.targets[target] = entry
    Object.assign(manifest.python.targets[target], entry)
    let failure = true
    const options = { userData: root, manifest, fetch: async () => new Response(bytes), verify: async (name: string) => { if (name === 'python' && failure) throw new Error('broken Python') } }
    const manager = new RuntimeManager(options)
    await manager.prepare()
    await Promise.all([manager.install('node'), manager.install('python')])
    expect(manager.state().node.phase).toBe('installed')
    expect(manager.state().python).toMatchObject({ phase: 'failed', error: 'verification' })
    failure = false
    await manager.install('python')
    expect(manager.state().python.phase).toBe('installed')
    const first = manager.state().node.location
    await manager.install('node')
    expect(manager.state().node.location).not.toBe(first)
    expect(readRuntimeReceipt(join(root, 'managed-toolchains'), 'node')?.retired).toHaveLength(1)
    await manager.shutdown()
  })
})

describe('secure runtime archives', () => {
  it.runIf(process.platform !== 'win32')('rejects escaping symlinks before extraction', async () => {
    const { root } = await fixture()
    const { symlink } = await import('node:fs/promises')
    await symlink('../../../outside', join(root, 'source/runtime/bin/unsafe'))
    const archive = join(root, 'unsafe.tar.gz')
    await tar({ cwd: join(root, 'source'), file: archive, gzip: true }, ['runtime'])
    const bytes = await readFile(archive)
    await expect(installRuntime({ name: 'node', version: '1.2.3', entry: { url: 'https://nodejs.org/test.tar.gz', archive: 'tar.gz', sha256: createHash('sha256').update(bytes).digest('hex') }, staging: join(root, 'stage'), destination: join(root, 'active'), platform: process.platform,
      fetch: async () => new Response(bytes), signal: new AbortController().signal, phase: () => {}, verify: async () => {},
    })).rejects.toMatchObject({ code: 'archive' })
  })
  it('rejects traversal in installation receipts and reports interruption without downloading', async () => {
    const { root } = await fixture()
    const managed = join(root, 'managed-toolchains/node')
    await mkdir(managed, { recursive: true })
    await writeFile(join(managed, 'active.json'), JSON.stringify({ version: '../outside', generation: 'a'.repeat(36), sha256: 'b'.repeat(64), pendingRemoval: true, retired: [] }))
    const manager = new RuntimeManager({ userData: root, fetch: async () => { throw new Error('unexpected download') } })
    expect(await manager.prepare()).toEqual({})
    expect(manager.state().node.error).toBe('corrupt')
    await rm(join(managed, 'active.json'))
    await writeFile(join(managed, 'installation.pending'), JSON.stringify({ version: '1.2.3', generation: 'a'.repeat(36), target: `${process.platform}-${process.arch}` }))
    const restarted = new RuntimeManager({ userData: root, fetch: async () => { throw new Error('unexpected download') } })
    expect(await restarted.prepare()).toEqual({})
    expect(restarted.state().node.error).toBe('interrupted')
    await restarted.shutdown()
    await manager.shutdown()
  })
  it.each(['version', 'generation', 'target'] as const)('rejects traversal in pending installation %s before deletion', async (field) => {
    const { root } = await fixture()
    const managed = join(root, 'managed-toolchains')
    await mkdir(join(managed, 'node'), { recursive: true })
    await writeFile(join(root, 'outside'), 'retain')
    await writeFile(join(managed, 'node/installation.pending'), JSON.stringify({
      version: '1.2.3', generation: 'a'.repeat(36), target: `${process.platform}-${process.arch}`, [field]: '../../outside',
    }))
    const manager = new RuntimeManager({ userData: root, fetch: async () => { throw new Error('unexpected download') } })
    try {
      expect(await manager.prepare()).toEqual({})
      expect(manager.state().node.error).toBe('corrupt')
      expect(await readFile(join(root, 'outside'), 'utf8')).toBe('retain')
    } finally {
      await manager.shutdown()
    }
  })
})
