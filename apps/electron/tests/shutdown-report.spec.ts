import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mergeMainShutdownFacts,
  shutdownReportPath,
  writeShutdownReportSync,
  type HostShutdownSection,
  type MainShutdownSection,
  type ShutdownReport,
} from '../src/harness/shutdown-report.ts'

const roots: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-shutdown-report-'))
  roots.push(home)
  return home
}

function hostSection(overrides: Partial<HostShutdownSection> = {}): HostShutdownSection {
  return {
    pid: 4242,
    reachedReady: true,
    requestedBy: 'SIGTERM',
    dispose: 'clean',
    exitCode: 0,
    ...overrides,
  }
}

function mainSection(overrides: Partial<MainShutdownSection> = {}): MainShutdownSection {
  return {
    pid: 4242,
    signal: 'SIGTERM',
    timeout: false,
    kill: false,
    exitCode: 0,
    signalCode: null,
    ...overrides,
  }
}

function readReport(home: string): ShutdownReport {
  return JSON.parse(readFileSync(shutdownReportPath(home), 'utf8')) as ShutdownReport
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Host shutdown report', () => {
  it('writes the host section atomically under $DSH_HOME/electron', () => {
    const home = makeHome()
    writeShutdownReportSync(home, hostSection())
    const report = readReport(home)
    expect(report.version).toBe(1)
    expect(report.host).toMatchObject(hostSection())
    expect(report.main).toBeUndefined()
    expect(readdirSync(join(home, 'electron')).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('merges the main section onto an existing host report', async () => {
    const home = makeHome()
    writeShutdownReportSync(home, hostSection())
    await mergeMainShutdownFacts(home, mainSection())
    const report = readReport(home)
    expect(report.host).toMatchObject({ pid: 4242, dispose: 'clean', reachedReady: true })
    expect(report.main).toMatchObject({ pid: 4242, signal: 'SIGTERM', timeout: false, kill: false, exitCode: 0 })
  })

  it('records a main-only report when the host never wrote one', async () => {
    const home = makeHome()
    await mergeMainShutdownFacts(home, mainSection({ exitCode: null, signalCode: 'SIGKILL' }))
    const report = readReport(home)
    expect(report.host).toBeUndefined()
    expect(report.main).toMatchObject({ pid: 4242, signalCode: 'SIGKILL' })
  })

  it('replaces a report left by a different child pid', async () => {
    const home = makeHome()
    writeShutdownReportSync(home, hostSection({ pid: 1111 }))
    await mergeMainShutdownFacts(home, mainSection({ pid: 1111, timeout: true, kill: true }))
    await mergeMainShutdownFacts(home, mainSection({ pid: 2222, signal: null }))
    const report = readReport(home)
    expect(report.main).toMatchObject({ pid: 2222, signal: null, timeout: false, kill: false })
  })

  it('keeps the strongest facts across repeated observations of one child', async () => {
    const home = makeHome()
    await mergeMainShutdownFacts(home, mainSection({ timeout: true, kill: true, signalCode: 'SIGKILL', exitCode: null }))
    await mergeMainShutdownFacts(home, mainSection({ signal: null, exitCode: 0, signalCode: null }))
    const report = readReport(home)
    expect(report.main).toMatchObject({ pid: 4242, signal: 'SIGTERM', timeout: true, kill: true, exitCode: null, signalCode: 'SIGKILL' })
  })

  it('drops a malformed report and keeps only the new observation', async () => {
    const home = makeHome()
    const path = shutdownReportPath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'not json', 'utf8')
    await mergeMainShutdownFacts(home, mainSection())
    const report = readReport(home)
    expect(report.host).toBeUndefined()
    expect(report.main).toMatchObject({ pid: 4242 })
  })
})
