/** Derive reproducible Store package versions from the Desktop release workflow sequence. */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Map Release run numbers to increasing 1.high.low.0 versions above the first Store release.
 * @param {string} runNumber GitHub's workflow run number, unchanged across attempts.
 * @returns {string} Store package version with components bounded by 65535.
 */
export function storeReleaseVersion(runNumber) {
  if (!/^[1-9]\d*$/.test(runNumber)) throw new Error('Store release requires a positive workflow run number')
  const sequence = Number(runNumber)
  if (!Number.isSafeInteger(sequence) || sequence > 0xffffffff) {
    throw new Error('Store release run number exceeds the 1.high.low.0 version range')
  }
  return `1.${Math.floor(sequence / 65536)}.${sequence % 65536}.0`
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = storeReleaseVersion(process.argv[2] ?? '')
  if (process.argv[3] === '--write') {
    const path = join(dirname(fileURLToPath(import.meta.url)), '../windows-store.json')
    const identity = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, `${JSON.stringify({ ...identity, version }, null, 2)}\n`)
  } else if (process.argv[3] !== undefined) {
    throw new Error('Usage: store-release-version.mjs <run-number> [--write]')
  }
  console.log(version)
}
