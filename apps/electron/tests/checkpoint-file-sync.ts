/** Windows file-flush permissions exercised on every test host. */
import * as fs from 'node:fs/promises'
import { onTestFinished, vi } from 'vitest'

/**
 * Reject file sync on read-only handles, as Windows FlushFileBuffers does.
 * Directory sync retains the host's semantics. Restores mocks after the test.
 */
export function requireWritableFileSync(): void {
  const open = fs.open
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    if (args[1] === 'r' && (await handle.stat()).isFile()) {
      const sync = vi.spyOn(handle, 'sync').mockRejectedValue(
        Object.assign(new Error('FlushFileBuffers requires write access'), { code: 'EPERM' }),
      )
      onTestFinished(() => { sync.mockRestore() })
    }
    return handle
  })
  onTestFinished(() => { spy.mockRestore() })
}
