/**
 * Parent side of the validation worker: spawns the read-only validator as a
 * child process on the Host runtime and parses its `RESULT` line. The child
 * receives SIGTERM on abort and SIGKILL after a two-second grace period;
 * cancellation settles only after its stdio closes.
 */

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
  signal?.throwIfAborted()
  const child = spawnHarnessChild(runtime.executable, [workerModule, '--anchor', installAnchor, '--root', sessionsRoot], {
    env: { ...process.env, ...runtime.env },
  })
  let killTimer: NodeJS.Timeout | undefined
  const onAbort = (): void => {
    if (child.exitCode !== null || child.signalCode !== null || killTimer !== undefined) return
    child.kill('SIGTERM')
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, WORKER_KILL_GRACE_MS)
  }
  let spawnError: Error | undefined
  child.once('error', (error) => { spawnError = error })
  const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once('close', (code, signalCode) => { resolve([code, signalCode]) })
  })
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  let result: CheckpointValidationReport | undefined
  let resultError: Error | undefined
  try {
    let buffered = ''
    // Stream-level decoding keeps a multibyte sequence split across chunks
    // intact; per-chunk Buffer.toString would inject replacement characters
    // into session ids, cwds, and error text inside the result JSON.
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk
      // A stdout chunk may split the result line mid-JSON; only complete
      // newline-terminated lines are parsed so a partial line never reaches
      // JSON.parse.
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (line.startsWith('RESULT ')) {
          try {
            result = JSON.parse(line.slice('RESULT '.length)) as CheckpointValidationReport
          } catch (error) {
            resultError = new Error(
              `validation worker returned a malformed result (${error instanceof Error ? error.message : String(error)})`,
            )
          }
        }
        newline = buffered.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { process.stderr.write(chunk) })
    // 'exit' may fire while worker stdout still holds undelivered bytes; 'close'
    // runs only after every stdio stream emitted its final data, so `buffered`
    // is complete here even for large reports.
    const [code, signalCode] = await closed
    // A worker that exited without a trailing newline may still have emitted a
    // complete result line; a truncated remainder fails the parse and reports
    // through the same malformed-result error below.
    if (result === undefined && resultError === undefined && buffered.startsWith('RESULT ')) {
      try {
        result = JSON.parse(buffered.slice('RESULT '.length)) as CheckpointValidationReport
      } catch (error) {
        resultError = new Error(
          `validation worker returned a malformed result (${error instanceof Error ? error.message : String(error)})`,
        )
      }
    }
    if (spawnError !== undefined) throw spawnError
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('checkpoint validation aborted')
    }
    if (resultError !== undefined) throw resultError
    if (result === undefined) {
      throw new Error(`validation worker exited without a result (code ${String(code)}, signal ${String(signalCode)})`)
    }
    return result
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (killTimer !== undefined) clearTimeout(killTimer)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await closed
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
