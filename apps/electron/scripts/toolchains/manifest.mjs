/** Repository-pinned toolchain assets; the lock is the sole checksum authority. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ELECTRON_ROOT, TARGETS } from './common.mjs'

const PYTHON_TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
}

export function loadManifest() {
  return validateManifest(JSON.parse(readFileSync(join(ELECTRON_ROOT, 'toolchains.lock.json'), 'utf8')))
}

export function validateManifest(lock) {
  if (lock.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/u.test(lock.node?.version ?? '')
    || !/^\d+\.\d+\.\d+$/u.test(lock.python?.version ?? '') || !/^\d{8}$/u.test(lock.python?.release ?? '')
    || lock.python?.distribution !== 'python-build-standalone' || lock.python?.flavor !== 'install_only_stripped') {
    throw new Error('desktop toolchains: invalid lock metadata')
  }
  for (const runtime of ['node', 'python']) {
    if (Object.keys(lock[runtime].targets).sort().join(',') !== [...TARGETS].sort().join(',')) {
      throw new Error(`desktop toolchains: incomplete ${runtime} targets`)
    }
    for (const [target, entry] of Object.entries(lock[runtime].targets)) {
      const url = new URL(entry.url)
      const nodeTarget = target.replace('win32-', 'win-')
      const nodeFile = `node-v${lock.node.version}-${nodeTarget}.${target.startsWith('win32-') ? 'zip' : 'tar.gz'}`
      const pythonFile = `cpython-${lock.python.version}+${lock.python.release}-${entry.target}-${lock.python.flavor}.tar.gz`
      if (url.protocol !== 'https:' || /latest/iu.test(entry.url)
        || !/^[a-f0-9]{64}$/u.test(entry.sha256)
        || (entry.archive !== 'zip' && entry.archive !== 'tar.gz')
        || (runtime === 'node' && (url.hostname !== 'nodejs.org'
          || decodeURIComponent(url.pathname) !== `/download/release/v${lock.node.version}/${nodeFile}`
          || entry.archive !== (target.startsWith('win32-') ? 'zip' : 'tar.gz')))
        || (runtime === 'python' && (url.hostname !== 'github.com'
          || entry.target !== PYTHON_TARGETS[target]
          || decodeURIComponent(url.pathname) !== `/astral-sh/python-build-standalone/releases/download/${lock.python.release}/${pythonFile}`
          || entry.archive !== 'tar.gz'))) {
        throw new Error(`desktop toolchains: invalid ${runtime} ${target} entry`)
      }
    }
  }
  return lock
}
