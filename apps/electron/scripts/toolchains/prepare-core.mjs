/** Windows Core executor retains console ownership without shipping npm or Agent commands. */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD_ROOT, target } from './common.mjs'
import { loadManifest } from './manifest.mjs'
import { prepareNode } from './prepare-node.mjs'
const name = target()
if (name.startsWith('win32-')) {
  const node = await prepareNode(loadManifest(), name)
  for (const directory of [join(BUILD_ROOT, 'core-runtime', name), join(BUILD_ROOT, 'core-runtime', 'current')]) {
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true })
    for (const file of ['node.exe', 'LICENSE']) cpSync(join(node, file), join(directory, file))
  }
}
