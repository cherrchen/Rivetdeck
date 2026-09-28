/** Execute prepared native assets with the same layout used by electron-builder. */
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { BUILD_ROOT, run } from './toolchains/common.mjs'
import { loadManifest } from './toolchains/manifest.mjs'
import { nodeExecutable } from './toolchains/prepare-node.mjs'
import { pythonExecutable } from './toolchains/prepare-python.mjs'

const lock = loadManifest()
const root = join(BUILD_ROOT, 'toolchains', 'current')
const target = `${process.platform}-${process.arch}`
const nodeRoot = join(root, 'node')
const pythonRoot = join(root, 'python')
const node = nodeExecutable(nodeRoot, target)
const python = pythonExecutable(pythonRoot, target)
const npmCli = join(nodeRoot, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'npm', 'bin', 'npm-cli.js')
run(node, ['--version'], `v${lock.node.version}`)
run(node, [npmCli, '--version'])
run(python, ['--version'], `Python ${lock.python.version}`)
const prefix = spawnSync(python, ['-c', 'import sys; print(sys.prefix)'], { encoding: 'utf8', windowsHide: true })
const observedPrefix = resolve(prefix.stdout.trim())
const expectedPrefix = resolve(pythonRoot)
if (prefix.status !== 0 || (process.platform === 'win32'
  ? observedPrefix.toLowerCase() !== expectedPrefix.toLowerCase()
  : observedPrefix !== expectedPrefix)) {
  throw new Error(`prepared Python does not use its packaged directory: ${prefix.stdout.trim()}`)
}
run(python, ['-m', 'pip', '--version'])
run(python, ['-c', 'import ssl, sqlite3, ctypes'])
console.log(`Desktop toolchains passed: Node ${lock.node.version}, Python ${lock.python.version}`)
