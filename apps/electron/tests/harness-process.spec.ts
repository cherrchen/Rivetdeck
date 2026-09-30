import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopHarness } from '../src/harness/process.ts'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal)
    return true
  }

  finish(signal: NodeJS.Signals | null = null): void {
    this.exitCode = signal === null ? 0 : null
    this.signalCode = signal
    this.emit('exit', this.exitCode, signal)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Harness process shutdown', () => {
  it('does not signal an already exited child', async () => {
    const child = new FakeChild()
    child.exitCode = 0
    await stopHarness(child, 50)
    expect(child.signals).toEqual([])
  })

  it('resolves after a graceful SIGTERM exit', async () => {
    const child = new FakeChild()
    const stopping = stopHarness(child, 50)
    expect(child.signals).toEqual(['SIGTERM'])
    child.finish('SIGTERM')
    await stopping
  })

  it('sends SIGKILL after the grace period and still waits for exit', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    let stopped = false
    const stopping = stopHarness(child, 50)
      .then(() => { stopped = true })

    expect(child.signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(50)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(stopped).toBe(false)

    child.finish('SIGKILL')
    await stopping
    expect(stopped).toBe(true)
  })
})
