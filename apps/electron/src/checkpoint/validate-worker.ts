/**
 * Validation worker entry, spawned as a separate child process during exit
 * checkpoint capture. Reads `--anchor <dsh package.json>` and `--root
 * <sessionsRoot>` from argv, validates every listed session through the real
 * read path, and prints one `RESULT <json>` line. Read-only by construction;
 * the supervisor kills the process to cancel.
 */

import { validateSessionsRoot } from './validate.ts'

async function main(): Promise<void> {
  const anchorIndex = process.argv.indexOf('--anchor')
  const rootIndex = process.argv.indexOf('--root')
  const sessionsRoot = rootIndex === -1 ? undefined : process.argv[rootIndex + 1]
  const installAnchor = anchorIndex === -1 ? undefined : process.argv[anchorIndex + 1]
  if (sessionsRoot === undefined || installAnchor === undefined) {
    process.stderr.write('validate-worker: --anchor and --root are required\n')
    process.exit(2)
  }
  const report = await validateSessionsRoot({ sessionsRoot, installAnchor })
  // A report larger than the pipe's synchronous window stays queued inside the
  // stream; exiting before the write callback runs would discard that tail, so
  // the process may leave only after the bytes are handed to the OS.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`RESULT ${JSON.stringify(report)}\n`, (error?: Error | null) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`validate-worker: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
