/** POSIX directory durability for checkpoint publication and journaled file replacement. */

import { mkdir, open, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Flush one directory's entries on POSIX; Windows does not support directory fsync.
 * @param path - Existing directory.
 * @returns Resolves after flushing, or immediately on Windows.
 */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Create a directory and persist its ancestry through the existing Harness home.
 * @param path - Directory inside `home`.
 * @param home - Existing home whose directory entries must also be flushed.
 * @returns Resolves once the created directory and its ancestors are durable on POSIX.
 */
export async function createDurableDirectory(path: string, home: string): Promise<void> {
  const root = resolve(home)
  await mkdir(path, { recursive: true, mode: 0o700 })
  for (let current = resolve(path); ; current = dirname(current)) {
    await syncDirectory(current)
    if (current === root) return
    if (dirname(current) === current) throw new Error(`directory ${path} is outside Harness home ${home}`)
  }
}

/**
 * Persist a staged tree's directory entries from leaves to root before publication.
 * Files must already have been flushed by their writer.
 * @param root - Private staged directory; symbolic links are not traversed.
 * @param signal - Cancellation between directory operations, before publication.
 * @returns Resolves after every directory has been flushed on POSIX.
 */
export async function syncDirectoryTree(root: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    signal?.throwIfAborted()
    if (entry.isDirectory()) await syncDirectoryTree(join(root, entry.name), signal)
  }
  signal?.throwIfAborted()
  await syncDirectory(root)
  signal?.throwIfAborted()
}
