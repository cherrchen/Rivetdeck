/**
 * Parent side of the validation worker: spawns the read-only validator as a
 * child process on the Host runtime and parses its `RESULT` line. The child
 * is killed when the abort signal fires, so a hung validation cannot outlive
 * the capture deadline.
 */

import { once } from 'node:events'
import { join } from 'node:path'
import { spawnHarnessChild, type HostRuntime } from '../runtime.ts'
import { validateSessionsRoot } from './validate.ts'
import type { CheckpointValidationReport } from './capture.ts'

const WORKER_KILL_GRACE_MS = 2_000

/**
 * Validate a sessions root inside a spawned worker child.
 * @param workerModule - Absolute path of the built `validate-worker.js`.
 * @param sessionsRoot - Sessions root the worker mounts read-only.
 * @param installAnchor - `@deepseek-ai/dsh/package.json` anchor of the supervised install.
 * @param runtime - Executable/environment for Node-compatible children.
 * @param signal - Cancellation; kills the worker.
 * @returns The worker's aggregate report.
 * @throws On worker failure, missing result, or abort.
 */
export async function runValidationWorker(
  workerModule: string,
  sessionsRoot: string,
  installAnchor: string,
  runtime: HostRuntime,
  signal?: AbortSignal,
): Promise<CheckpointValidationReport> {
  const child = spawnHarnessChild(runtime.executable, [workerModule, '--anchor', installAnchor, '--root', sessionsRoot], {
    env: { ...process.env, ...runtime.env },
  })
  const onAbort = (): void => { child.kill('SIGTERM') }
  signal?.addEventListener('abort', onAbort, { once: true })
  let result: CheckpointValidationReport | undefined
  try {
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const line = output.split('\n').find(entry => entry.startsWith('RESULT '))
      if (line !== undefined) {
        result = JSON.parse(line.slice('RESULT '.length)) as CheckpointValidationReport
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { process.stderr.write(chunk) })
    const [code, signalCode] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('checkpoint validation aborted')
    }
    if (result === undefined) {
      throw new Error(`validation worker exited without a result (code ${String(code)}, signal ${String(signalCode)})`)
    }
    return result
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, WORKER_KILL_GRACE_MS))])
    }
  }
}

/** In-process validator used where spawning is impossible (tests and embedding callers). */
export function createInProcessValidator(
  installAnchor: string,
): (sessionsRoot: string, signal?: AbortSignal) => Promise<CheckpointValidationReport> {
  return (sessionsRoot, signal) => validateSessionsRoot({ sessionsRoot, installAnchor, ...(signal === undefined ? {} : { signal }) })
}

/** Built worker module path below the Electron application root. */
export function validateWorkerModule(appPath: string): string {
  return join(appPath, 'lib', 'checkpoint', 'validate-worker.js')
}
