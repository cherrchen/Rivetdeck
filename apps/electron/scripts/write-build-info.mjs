/**
 * Write apps/electron/build-info.json for the packaged About revision rows.
 * Release CI sets RIVETDECK_BUILD to the desktop-release workflow run number.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const electronRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = join(electronRoot, 'build-info.json')

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ build?: string, commit?: string }}
 */
export function buildInfoDocument(env = process.env) {
  const build = trim(env.RIVETDECK_BUILD)
  const commitSource = trim(env.RIVETDECK_COMMIT) ?? trim(env.GITHUB_SHA)
  const commit = commitSource === undefined ? undefined : commitSource.slice(0, 9)
  return {
    ...build === undefined ? {} : { build },
    ...commit === undefined ? {} : { commit },
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [path]
 * @returns {string}
 */
export function writeBuildInfo(env = process.env, path = outputPath) {
  writeFileSync(path, `${JSON.stringify(buildInfoDocument(env), null, 2)}\n`)
  return path
}

/** @param {string | undefined} value */
function trim(value) {
  if (value === undefined) return undefined
  const next = value.trim()
  return next.length === 0 ? undefined : next
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  writeBuildInfo()
}
