import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PATH_HISTORY_FILE,
  mergeLaunchPathHistory,
  parsePathHistory,
  renderPathHistory,
} from '../src/path-history.ts'

const created: string[] = []
async function freshAppDataDir() {
  const dir = await mkdtemp(join(tmpdir(), 'path-history-appdata-'))
  created.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(created.map(dir => rm(dir, { recursive: true, force: true })))
})

describe('Electron path history', () => {
  it('round-trips records without dropping earlier roots', () => {
    const record = parsePathHistory(
      'complete=1\r\nuserData=C:\\Users\\me\\AppData\\Roaming\\Rivetdeck\r\ndshHome=C:\\Users\\me\\.dsh\r\n')
    expect(record).toEqual({
      complete: true,
      userData: ['C:\\Users\\me\\AppData\\Roaming\\Rivetdeck'],
      dshHome: ['C:\\Users\\me\\.dsh'],
      unrecognized: [],
    })
    expect(parsePathHistory(renderPathHistory(record))).toEqual(record)
  })

  it('carries lines it cannot parse through every rewrite', async () => {
    const appDataDir = await freshAppDataDir()
    const recordPath = join(appDataDir, PATH_HISTORY_FILE)
    // Unknown keys, malformed lines, and empty path claims may all hide protection
    // claims the uninstaller refuses to ignore; a merge must keep them verbatim.
    await writeFile(recordPath,
      'complete=1\r\nworkspace=C:\\ws\r\nnot-a-claim\r\nuserData=\r\nuserData=C:\\first\r\n')
    const record = await mergeLaunchPathHistory({
      appDataDir,
      userData: 'D:\\second',
      dshHome: 'D:\\home',
    })
    expect(record?.complete).toBe(true)
    expect(record?.unrecognized).toEqual(['workspace=C:\\ws', 'not-a-claim', 'userData='])
    const stored = await readFile(recordPath, 'utf8')
    for (const line of ['workspace=C:\\ws', 'not-a-claim', 'userData=']) {
      expect(stored).toContain(line)
    }
    // The claims survive arbitrarily many further rewrites.
    const reparsed = parsePathHistory(stored)
    expect(reparsed.unrecognized).toEqual(record?.unrecognized)
  })

  it('leaves an unreadable record untouched instead of overwriting it', async () => {
    const appDataDir = await freshAppDataDir()
    // A directory at the record path is a record this reader cannot inspect; replacing
    // it could erase claims the uninstaller would honor, so the merge refuses.
    await mkdir(join(appDataDir, PATH_HISTORY_FILE))
    await expect(mergeLaunchPathHistory({
      appDataDir,
      userData: 'D:\\second',
      dshHome: 'D:\\home',
    })).rejects.toThrow()
  })

  it('marks a first-ever record incomplete', async () => {
    const appDataDir = await freshAppDataDir()
    const record = await mergeLaunchPathHistory({
      appDataDir,
      userData: 'D:\\data\\Rivetdeck',
      dshHome: 'D:\\home\\.dsh',
    })
    expect(record).toMatchObject({ complete: false })
    const stored = parsePathHistory(await readFile(join(appDataDir, PATH_HISTORY_FILE), 'utf8'))
    expect(stored.userData).toEqual(['D:\\data\\Rivetdeck'])
    expect(stored.dshHome).toEqual(['D:\\home\\.dsh'])
  })

  it('merges relocated roots and keeps the installer-seeded completeness', async () => {
    const appDataDir = await freshAppDataDir()
    await writeFile(join(appDataDir, PATH_HISTORY_FILE), 'complete=1\r\nuserData=C:\\first\r\n')
    const record = await mergeLaunchPathHistory({
      appDataDir,
      userData: 'D:\\second',
      dshHome: 'D:\\home',
    })
    expect(record?.complete).toBe(true)
    expect(record?.userData).toEqual(['C:\\first', 'D:\\second'])
  })

  it('accumulates duplicate roots once', async () => {
    const appDataDir = await freshAppDataDir()
    await mergeLaunchPathHistory({ appDataDir, userData: 'C:\\same', dshHome: 'C:\\same-home' })
    const record = await mergeLaunchPathHistory({ appDataDir, userData: 'C:\\same', dshHome: 'C:\\same-home' })
    expect(record?.userData).toEqual(['C:\\same'])
  })

  it('retains both launches when independent processes contend for the history', async () => {
    const appDataDir = await freshAppDataDir()
    const recordPath = join(appDataDir, PATH_HISTORY_FILE)
    await writeFile(recordPath, 'complete=1\r\n')
    const children: ReturnType<typeof writer>[] = []
    function writer(label: string) {
      const child = fork(join(import.meta.dirname, 'fixtures/path-history-writer.mjs'),
        [appDataDir, `C:\\data-${label}`, `C:\\home-${label}`], {
          execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, '../../../tsconfig.json') },
        })
      let stderr = ''
      child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
      const messages: unknown[] = []
      child.on('message', (message) => { messages.push(message) })
      const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => { resolve({ code, signal }) })
      })
      return { child, messages, done, stderr: () => stderr }
    }
    async function message(process: ReturnType<typeof writer>) {
      if (process.messages.length === 0) {
        await Promise.race([
          once(process.child, 'message'),
          process.done.then(() => { throw new Error(`Writer exited before its barrier: ${process.stderr()}`) }),
        ])
      }
      return process.messages.shift()
    }
    async function exited(process: ReturnType<typeof writer>) {
      const { code, signal } = await process.done
      expect(signal, process.stderr()).toBeNull()
      expect(code, process.stderr()).toBe(0)
    }
    try {
      const first = writer('A')
      children.push(first)
      expect(await message(first)).toBe('read')
      const second = writer('B')
      children.push(second)
      // An unlocked implementation reaches a stale read; a locked writer reports
      // contention before it can read the first writer's committed roots.
      const secondState = await message(second)
      expect(['contended', 'read']).toContain(secondState)
      first.child.send('release')
      await exited(first)
      if (secondState === 'contended') expect(await message(second)).toBe('read')
      second.child.send('release')
      await exited(second)
      const stored = parsePathHistory(await readFile(recordPath, 'utf8'))
      expect(stored.complete).toBe(true)
      expect(stored.userData).toEqual(['C:\\data-A', 'C:\\data-B'])
      expect(stored.dshHome).toEqual(['C:\\home-A', 'C:\\home-B'])
      await expect(readFile(`${recordPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill()
      }
      await Promise.all(children.map(process => process.done))
    }
  })
})
