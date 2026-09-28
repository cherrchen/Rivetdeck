import { loadManifest } from './manifest.mjs'
import { target } from './common.mjs'
import { prepareNode } from './prepare-node.mjs'
import { preparePython } from './prepare-python.mjs'

export async function prepareToolchains(mode = 'all') {
  if (!['node', 'python', 'all'].includes(mode)) throw new Error(`unknown toolchain preparation: ${mode}`)
  const manifest = loadManifest()
  const name = target()
  if (mode !== 'python') console.log(`Node: ${await prepareNode(manifest, name)}`)
  if (mode !== 'node') console.log(`Python: ${await preparePython(manifest, name)}`)
}

if (process.argv[1] === import.meta.filename) await prepareToolchains(process.argv[2] ?? 'all')
