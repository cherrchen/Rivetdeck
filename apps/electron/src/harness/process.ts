/** Supervised Harness child-process shutdown primitives. */

import type { ChildProcess } from 'node:child_process'

type HarnessChild = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'kill'> & {
  connected?: boolean
  send?: ChildProcess['send']
  once(event: 'exit', listener: (exitCode: number | null, signalCode: NodeJS.Signals | null) => void): void
}

/** Private parent-to-Host request for a cooperative drain on every platform. */
export const HARNESS_SHUTDOWN_MESSAGE = 'desktop/shutdown'

/** Grace period before a supervised Harness process receives SIGKILL. */
export const HARNESS_STOP_TIMEOUT_MS = 5_000

/** Supervision facts `stopHarness` observed while draining the child. */
export interface HarnessStopReport {
  /** First signal delivered; null for IPC requests or an already exited child. */
  readonly signal: NodeJS.Signals | null
  /** The cooperative shutdown grace period elapsed before the exit event. */
  readonly timeout: boolean
  /** SIGKILL was delivered after the grace period. */
  readonly kill: boolean
  /** Exit code on the `exit` event; null when the child left by signal. */
  readonly exitCode: number | null
  /** Exit signal on the `exit` event; null when the child left by code. */
  readonly signalCode: NodeJS.Signals | null
}

/**
 * Stop a supervised Harness process and resolve only after its exit event.
 * @param child - Spawned Harness child process.
 * @param gracefulTimeoutMs - Time allowed for cooperative shutdown before SIGKILL.
 * @returns What the supervisor did and the child's exit result.
 */
export async function stopHarness(
  child: HarnessChild,
  gracefulTimeoutMs = HARNESS_STOP_TIMEOUT_MS,
): Promise<HarnessStopReport> {
  if (hasExited(child)) {
    return {
      signal: null,
      timeout: false,
      kill: false,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    }
  }
  const exited = new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (exitCode, signalCode) => { resolve({ exitCode, signalCode }) })
  })

  const signal = child.connected === true && child.send !== undefined ? null : 'SIGTERM'
  if (signal === null) {
    child.send?.({ type: HARNESS_SHUTDOWN_MESSAGE }, (error: Error | null) => {
      if (error !== null) console.error('desktop Host shutdown request failed', error)
    })
  } else {
    signalChild(child, signal)
  }
  if (await exitsWithin(exited, gracefulTimeoutMs)) {
    return { signal, timeout: false, kill: false, ...(await exited) }
  }
  const kill = !hasExited(child)
  if (kill) signalChild(child, 'SIGKILL')
  return { signal, timeout: true, kill, ...(await exited) }
}

function hasExited(child: HarnessChild): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function signalChild(child: HarnessChild, signal: NodeJS.Signals): void {
  if (child.kill(signal) || hasExited(child)) return
  throw new Error(`Harness process did not accept ${signal}.`)
}

async function exitsWithin(exited: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, timeoutMs)
  })
  try {
    return await Promise.race([exited.then(() => true as const), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
