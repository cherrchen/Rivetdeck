/** Pre-Host maintenance ordering, including journals created by this launch's restores. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { restoreJournalsDir } from './journal.ts'

/**
 * Remember decisions for unchanged journal bytes and outcomes within one launch.
 * Read failures remain unacknowledged because the journal state is unknown.
 * @param home - Harness home containing the restore journals.
 * @returns A selector whose returned decisions can be acknowledged after presentation.
 */
export function createRestoreJournalDecisions(home: string) {
  const acknowledged = new Map<string, string>()
  return async (kind: 'deferred' | 'unresolvable' | 'conflicted', ids: readonly string[]) => {
    const pending = []
    for (const id of ids) {
      const state = await readFile(join(restoreJournalsDir(home), `${id}.json`), 'utf8').catch(() => undefined)
      const fingerprint = `${kind}:${state}`
      if (state !== undefined && acknowledged.get(id) === fingerprint) continue
      pending.push({
        id,
        acknowledge: () => {
          if (state !== undefined) acknowledged.set(id, fingerprint)
        },
      })
    }
    return pending
  }
}

/**
 * Keep the Host stopped until restore journals pass the startup decision.
 * Detection and prompt errors are reported before the final journal check.
 * @param options - Journal decision, restore work, and maintenance error reporter.
 * @returns Whether the caller may start the Host.
 */
export async function runStartupSessionMaintenance(options: {
  readonly gate: (decisions: ReturnType<typeof createRestoreJournalDecisions>) => Promise<boolean>
  readonly home: string
  readonly maintain: () => Promise<void>
  readonly onError: (error: unknown) => void
}): Promise<boolean> {
  const decisions = createRestoreJournalDecisions(options.home)
  if (!await options.gate(decisions)) return false
  try {
    await options.maintain()
  } catch (error) {
    options.onError(error)
  }
  return options.gate(decisions)
}
