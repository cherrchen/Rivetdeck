import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { prepare, run, updateCurrent } from './common.mjs'

export function nodeExecutable(root, targetName) {
  return join(root, targetName.startsWith('win32-') ? 'node.exe' : 'bin/node')
}

export async function prepareNode(lock, targetName) {
  const entry = lock.node.targets[targetName]
  const root = await prepare('node', targetName, entry, path => nodeExecutable(path, targetName), path => {
    const npmRoot = join(path, targetName.startsWith('win32-') ? 'node_modules/npm/bin' : 'lib/node_modules/npm/bin')
    if (['npm-cli.js', 'npx-cli.js'].some(name => !existsSync(join(npmRoot, name)))) {
      throw new Error('bundled Node distribution is missing npm or npx')
    }
    run(nodeExecutable(path, targetName), ['--version'], `v${lock.node.version}`)
  })
  updateCurrent('node', root, entry)
  return root
}
