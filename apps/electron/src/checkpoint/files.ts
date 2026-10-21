/** Checkpoint file hashing, cancellable candidate cleanup, and directory durability. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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

/**
 * Hash file bytes with bounded buffering and close the stream before returning.
 * @param path - File to read.
 * @param signal - Cancellation also interrupts an active read.
 * @returns Byte count and SHA-256 digest.
 */
export async function digestFile(path: string, signal?: AbortSignal): Promise<{ size: number; sha256: string }> {
  signal?.throwIfAborted()
  const stream = createReadStream(path, { signal })
  const hash = createHash('sha256')
  let size = 0
  await pipeline(stream, new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      hash.update(chunk)
      callback()
    },
  }), { signal })
  signal?.throwIfAborted()
  return { size, sha256: hash.digest('hex') }
}

/**
 * Remove a private staged tree, stopping between filesystem operations on cancellation.
 * @param path - Staged directory; child symbolic links are unlinked without traversal.
 * @param signal - Cancellation leaves the remainder for a later sweep.
 * @returns Resolves after removal; rejects on cancellation or filesystem failure.
 */
export async function removeStagedTree(path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  let entries
  try {
    const info = await lstat(path)
    signal?.throwIfAborted()
    if (!info.isDirectory()) {
      await unlink(path)
      return
    }
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    signal?.throwIfAborted()
    const child = join(path, entry.name)
    if (entry.isDirectory()) await removeStagedTree(child, signal)
    else await unlink(child)
  }
  signal?.throwIfAborted()
  await rmdir(path)
}
