/** Allocate private probe directories shared by packaged Main and external Node processes. */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Store probes use the build workspace because AppX redirects new AppData files for packaged writers.
 * @param {string} prefix Probe directory name prefix.
 * @param {boolean} store Whether the probe launches an installed Store application.
 * @returns {Promise<string>} Exclusively allocated directory; the caller owns recursive cleanup.
 */
export async function createSmokeScratch(prefix, store) {
  const parent = store ? resolve(import.meta.dirname, '../.electron-build') : tmpdir()
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, prefix))
}
