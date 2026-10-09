/** Restore a reused unsigned AppX artifact's version before Store qualification. */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateStoreIdentity } from './prepare-windows-store.mjs'

/**
 * Restore the version encoded in the artifact name; qualification checks the AppX manifest against it.
 * Invalid names, versions, architectures, or extra entries fail without changing the configuration.
 * @param {string} projectDir Electron application directory containing windows-store.json.
 * @param {string} packageDirectory Directory containing one unsigned AppX artifact.
 * @param {string} architecture Qualification runner architecture (x64 or arm64).
 * @returns {Promise<string>} Restored Store package version.
 */
export async function restoreWindowsStoreVersion(projectDir, packageDirectory, architecture) {
  if (!['x64', 'arm64'].includes(architecture)) throw new Error('Store qualification requires x64 or arm64')
  const entries = await readdir(packageDirectory, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0].isFile()) {
    throw new Error('Store version restoration requires exactly one unsigned AppX artifact')
  }
  const match = /^Rivetdeck-store-([0-9.]+)-(x64|arm64)\.appx$/.exec(entries[0].name)
  if (match === null || match[2] !== architecture) {
    throw new Error('Store artifact name must encode its version and qualification architecture')
  }
  const path = join(projectDir, 'windows-store.json')
  const identity = JSON.parse(await readFile(path, 'utf8'))
  const restored = validateStoreIdentity({ ...identity, version: match[1] })
  await writeFile(path, `${JSON.stringify(restored, null, 2)}\n`)
  return restored.version
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  console.log(await restoreWindowsStoreVersion(project, resolve(process.argv[2] ?? ''), process.argv[3] ?? ''))
}
