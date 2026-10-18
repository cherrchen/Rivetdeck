import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createProcessShutdown,
  parseHostArguments,
  type HostExitTarget,
  type HostShutdownState,
} from '../src/host.ts'
import type { HostDisposeOutcome } from '../src/harness/shutdown-report.ts'

describe('Desktop Host argv', () => {
  it('parses application path, overlay, and web-app arguments', () => {
    expect(parseHostArguments(['/app', '/data/overlay.yml', '--', '--port', '0', '--no-open'])).toEqual({
      appPath: resolve('/app'),
      patchPath: resolve('/data/overlay.yml'),
      args: ['--port', '0', '--no-open'],
    })
  })

  it('defaults web-app arguments when none are supplied', () => {
    expect(parseHostArguments(['/app', '/data/overlay.yml']).args).toEqual(['--port', '0', '--no-open'])
  })

  it('fails loud when required paths are missing', () => {
    expect(() => parseHostArguments(['/app'])).toThrow(/expected <appPath> <patchPath>/)
  })
})

describe('Desktop Host shutdown report', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  class FakeTarget implements HostExitTarget {
    exitCode: number | undefined
    readonly exits: number[] = []
    exit(code: number): void {
      this.exits.push(code)
    }
    applyExitCode(code: number): void {
      this.exitCode = code
    }
  }

  function setup(dispose: () => Promise<void>) {
    const state: HostShutdownState = { requestedBy: null, reachedReady: true }
    const target = new FakeTarget()
    const reports: { dispose: HostDisposeOutcome; exitCode: number | null }[] = []
    const shutdown = createProcessShutdown(
      dispose,
      state,
      (outcome, exitCode) => { reports.push({ dispose: outcome, exitCode }) },
      target,
    )
    return { state, target, reports, shutdown }
  }

  it('reports a clean drain on the cli exit channel without forcing exit', async () => {
    const { state, target, reports, shutdown } = setup(async () => {})
    await shutdown.shutdown(0, 'cli')
    expect(state.requestedBy).toBe('cli')
    expect(reports).toEqual([{ dispose: 'clean', exitCode: 0 }])
    expect(target.exitCode).toBe(0)
    expect(target.exits).toEqual([])
  })

  it('reports a clean drain then forces exit on signal', async () => {
    const { state, target, reports, shutdown } = setup(async () => {})
    shutdown.interrupt(0, 'SIGTERM')
    await vi.waitFor(() => { expect(reports).toEqual([{ dispose: 'clean', exitCode: 0 }]) })
    expect(state.requestedBy).toBe('SIGTERM')
    expect(target.exits).toEqual([0])
  })

  it('reports a failed drain', async () => {
    const { target, reports, shutdown } = setup(async () => { throw new Error('dispose exploded') })
    await shutdown.shutdown(1, 'cli')
    expect(reports).toEqual([{ dispose: 'failed', exitCode: 1 }])
    expect(target.exits).toEqual([1])
  })

  it('reports a drain timeout after the shutdown window', async () => {
    vi.useFakeTimers()
    const { target, reports, shutdown } = setup(async () => new Promise(() => {}))
    void shutdown.shutdown(0, 'cli')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reports).toEqual([{ dispose: 'timeout', exitCode: 0 }])
    expect(target.exits).toEqual([0])
  })

  it('reports an interrupted drain and keeps the first request cause', async () => {
    const { state, target, reports, shutdown } = setup(async () => new Promise(() => {}))
    shutdown.interrupt(0, 'SIGTERM')
    shutdown.interrupt(130, 'SIGINT')
    expect(state.requestedBy).toBe('SIGTERM')
    expect(reports).toEqual([{ dispose: 'interrupted', exitCode: 130 }])
    expect(target.exits).toEqual([130])
  })
})
