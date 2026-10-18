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
    const report = await stopHarness(child, 50)
    expect(child.signals).toEqual([])
    expect(report).toEqual({ signal: null, timeout: false, kill: false, exitCode: 0, signalCode: null })
  })

  it('reports a nonzero exit of an already exited child', async () => {
    const child = new FakeChild()
    child.exitCode = 1
    const report = await stopHarness(child, 50)
    expect(child.signals).toEqual([])
    expect(report).toMatchObject({ signal: null, exitCode: 1 })
  })

  it('resolves after a graceful SIGTERM exit and reports it', async () => {
    const child = new FakeChild()
    const stopping = stopHarness(child, 50)
    expect(child.signals).toEqual(['SIGTERM'])
    child.finish()
    const report = await stopping
    expect(report).toEqual({ signal: 'SIGTERM', timeout: false, kill: false, exitCode: 0, signalCode: null })
  })

  it('reports a child that exits by signal', async () => {
    const child = new FakeChild()
    const stopping = stopHarness(child, 50)
    child.finish('SIGTERM')
    const report = await stopping
    expect(report).toMatchObject({ signal: 'SIGTERM', timeout: false, kill: false, exitCode: null, signalCode: 'SIGTERM' })
  })

  it('sends SIGKILL after the grace period, still waits for exit, and reports both', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const stopping = stopHarness(child, 50)

    expect(child.signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(50)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])

    child.finish('SIGKILL')
    const report = await stopping
    expect(report).toEqual({ signal: 'SIGTERM', timeout: true, kill: true, exitCode: null, signalCode: 'SIGKILL' })
  })
})
