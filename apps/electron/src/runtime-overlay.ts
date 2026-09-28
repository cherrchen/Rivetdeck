import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { generateOwnershipOverlay, HOST_PATCH_RELATIVE } from './ownership-overlay.ts'
import { writeTextFileAtomic } from './text-file.ts'

/** Writable Host patch passed to the supervised `dsh web` process. */
export interface HostRuntimeOverlay {
  patchPath: string
}

/**
 * Write the ownership-aware Desktop composition into writable user data.
 * @param appPath - Electron application root.
 * @param userDataPath - Writable Electron userData directory.
 * @param harnessHome - Active `$DSH_HOME` used to scan pre-Electron layers.
 * @returns Writable Host patch path.
 */
export async function prepareHostRuntimeOverlay(
  appPath: string,
  userDataPath: string,
  harnessHome: string,
): Promise<HostRuntimeOverlay> {
  mkdirSync(userDataPath, { recursive: true })
  const patchPath = join(userDataPath, 'electron-host.patch.yml')
  await writeTextFileAtomic(patchPath, generateOwnershipOverlay(appPath, harnessHome))
  return { patchPath }
}

/**
 * Copy the static Host overlay into a destination tree for packaging or tests.
 * @param appPath - Source application root.
 * @param destinationRoot - Destination application root.
 */
export function copyRuntimeOverlay(appPath: string, destinationRoot: string): void {
  const from = join(appPath, HOST_PATCH_RELATIVE)
  const toDir = join(destinationRoot, 'runtime')
  mkdirSync(toDir, { recursive: true })
  copyFileSync(from, join(toDir, 'host.patch.yml'))
}
