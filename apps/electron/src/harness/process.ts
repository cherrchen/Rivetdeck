/** Supervised Harness child-process shutdown primitives. */

import type { ChildProcess } from 'node:child_process'

type HarnessChild = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'kill'> & {
  once(event: 'exit', listener: () => void): void
}

/** Grace period before a supervised Harness process receives SIGKILL. */
export const HARNESS_STOP_TIMEOUT_MS = 5_000

/**
 * Stop a supervised Harness process and resolve only after its exit event.
 * @param child - Spawned Harness child process.
 * @param gracefulTimeoutMs - Time allowed after SIGTERM before SIGKILL.
 */
export async function stopHarness(
  child: HarnessChild,
  gracefulTimeoutMs = HARNESS_STOP_TIMEOUT_MS,
): Promise<void> {
  if (hasExited(child)) return
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => { resolve() })
  })

  signalChild(child, 'SIGTERM')
  if (await exitsWithin(exited, gracefulTimeoutMs)) return
  if (!hasExited(child)) signalChild(child, 'SIGKILL')
  await exited
}

function hasExited(child: HarnessChild): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function signalChild(child: HarnessChild, signal: NodeJS.Signals): void {
  if (child.kill(signal) || hasExited(child)) return
  throw new Error(`Harness process did not accept ${signal}.`)
}

async function exitsWithin(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
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
