import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const writeQueues = new Map<string, Promise<void>>()
const WINDOWS_RENAME_RETRY_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM'])
const WINDOWS_RENAME_RETRY_LIMIT = 8

/**
 * Serialize one in-process read-modify-write operation for a Desktop file.
 * Electron enforces a single application instance, so the queue covers every
 * supported writer while avoiding a stale on-disk lock after a crash.
 * @param path - Final file path whose writers share a queue.
 * @param operation - Work performed after all earlier writers settle.
 * @returns operation result.
 */
export async function withDesktopFileWriter<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve()
  let release = (): void => {}
  const current = new Promise<void>((resolve) => { release = resolve })
  writeQueues.set(path, current)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (writeQueues.get(path) === current) writeQueues.delete(path)
  }
}

/**
 * Atomically and durably replace one Desktop-private text file.
 * A random exclusive sibling is flushed before rename; supported POSIX hosts
 * also flush the parent directory after the rename. The old file remains
 * visible if writing or flushing the sibling fails.
 * @param path - Final file path.
 * @param content - Complete UTF-8 content.
 */
export async function writeDesktopFileAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await renameDesktopPath(temporary, path)
    if (process.platform !== 'win32') {
      const directoryHandle = await open(directory, 'r')
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Atomically rename a Desktop file or directory, with bounded Windows file-lock retries.
 * @param source Existing file or directory.
 * @param destination Final path; filesystem replacement rules apply.
 * @param options Target platform and optional cancellation during retries.
 * @returns Resolves after rename succeeds; permanent errors and cancellation reject.
 */
export async function renameDesktopPath(
  source: string, destination: string,
  options: { platform?: NodeJS.Platform; signal?: AbortSignal } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform
  let delayMs = 20
  for (let attempts = 0;; attempts += 1) {
    options.signal?.throwIfAborted()
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : ''
      if (platform !== 'win32'
        || !WINDOWS_RENAME_RETRY_ERRORS.has(code)
        || attempts >= WINDOWS_RENAME_RETRY_LIMIT) throw error
    }
    await delay(delayMs, undefined, { signal: options.signal })
    delayMs = Math.min(delayMs * 2, 200)
  }
}
