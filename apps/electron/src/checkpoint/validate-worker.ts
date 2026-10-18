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
  process.stdout.write(`RESULT ${JSON.stringify(report)}\n`)
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
