/** Read profile writer ownership without copying configuration or package-run arguments. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Sample the writer PID, package-run PID, and completed ecosystem installation marker.
 * Files may change between reads; each observation reports absence independently.
 * @param {string} home Probe-owned Harness home.
 * @returns {Promise<{holderPid: number | null, packagePid: number | null, ecosystemCompleted: boolean}>} Observed ownership only.
 */
export async function readProfileWriterState(home) {
  /** @param {string} path */
  const optionalText = async path => {
    try { return await readFile(path, 'utf8') }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error }
  }
  const profile = join(home, 'profiles', 'web')
  const [lock, run, marker] = await Promise.all([
    optionalText(join(profile, 'package.json.lock')),
    optionalText(join(profile, '.plugin-manager', 'run.json')),
    optionalText(join(home, 'electron', 'ecosystem-preinstalled')),
  ])
  /** @param {unknown} value */
  const pid = value => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Profile writer diagnostic requires a positive PID')
    return value
  }
  if (lock !== undefined && !/^\d+\s*$/.test(lock)) throw new Error('Profile writer diagnostic found an invalid lock record')
  /** @type {unknown} */
  const packageRun = run === undefined ? undefined : JSON.parse(run)
  if (run !== undefined && (typeof packageRun !== 'object' || packageRun === null || !('pid' in packageRun))) throw new Error('Profile writer diagnostic found an invalid package-run record')
  return {
    holderPid: lock === undefined ? null : pid(Number(lock.trim())),
    packagePid: packageRun === undefined ? null : pid(typeof packageRun === 'object' && packageRun !== null && 'pid' in packageRun ? packageRun.pid : undefined),
    ecosystemCompleted: marker !== undefined,
  }
}
