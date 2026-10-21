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

  it('retires cleanup candidates without dropping homes or unknown protection claims', async () => {
    const appDataDir = await freshAppDataDir()
    const recordPath = join(appDataDir, PATH_HISTORY_FILE)
    await writeFile(recordPath,
      'complete=1\r\nuserData=C:\\old-data\r\ndshHome=C:\\old-home\r\n'
      + 'futureHome=C:\\protected\r\nReTiReD=1\r\ncomplete=1\r\n')
    const retired = parsePathHistory(await readFile(recordPath, 'utf8'))
    expect(retired).toEqual({
      complete: false, userData: [], dshHome: ['C:\\old-home'],
      unrecognized: ['futureHome=C:\\protected'],
    })
    const current = await mergeLaunchPathHistory({
      appDataDir, defaultUserData: 'C:\\default', userData: 'C:\\new-data', dshHome: 'C:\\new-home',
    })
    expect(current).toEqual({
      complete: false, userData: ['C:\\new-data'], dshHome: ['C:\\old-home', 'C:\\new-home'],
      unrecognized: ['futureHome=C:\\protected'],
    })
    const stored = await readFile(recordPath, 'utf8')
    expect(stored).not.toContain('old-data')
    expect(stored).not.toContain('retired=')
    expect(parsePathHistory(stored)).toEqual(current)
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
      defaultUserData: 'C:\\default',
      userData: 'C:\\first',
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
      defaultUserData: 'C:\\default',
      userData: 'D:\\second',
      dshHome: 'D:\\home',
    })).rejects.toThrow()
  })

  it('marks a first-ever record incomplete', async () => {
    const appDataDir = await freshAppDataDir()
    const record = await mergeLaunchPathHistory({
      appDataDir,
      defaultUserData: 'C:\\default',
      userData: 'D:\\data\\Rivetdeck',
      dshHome: 'D:\\home\\.dsh',
    })
    expect(record).toMatchObject({ complete: false })
    const stored = parsePathHistory(await readFile(join(appDataDir, PATH_HISTORY_FILE), 'utf8'))
    expect(stored.userData).toEqual(['D:\\data\\Rivetdeck'])
    expect(stored.dshHome).toEqual(['D:\\home\\.dsh'])
  })

  it('limits installer-seeded completeness to the default userData root', async () => {
    const appDataDir = await freshAppDataDir()
    const defaultUserData = join(appDataDir, 'Rivetdeck')
    const recordPath = join(appDataDir, PATH_HISTORY_FILE)
    await writeFile(recordPath, 'complete=1\r\n')
    const record = await mergeLaunchPathHistory({
      appDataDir, defaultUserData, userData: defaultUserData, dshHome: join(appDataDir, 'home'),
    })
    expect(record.complete).toBe(true)
    expect(record.userData).toEqual([defaultUserData])
    expect(parsePathHistory(await readFile(recordPath, 'utf8'))).toEqual(record)
  })

  it('keeps completeness for a recorded root when the current home changes', async () => {
    const appDataDir = await freshAppDataDir()
    await writeFile(join(appDataDir, PATH_HISTORY_FILE),
      'complete=1\r\nuserData=C:\\known\r\ndshHome=C:\\old-home\r\n')
    const record = await mergeLaunchPathHistory({
      appDataDir, defaultUserData: 'C:\\default', userData: 'C:\\known', dshHome: 'C:\\new-home',
    })
    expect(record.complete).toBe(true)
    expect(record.userData).toEqual(['C:\\known'])
    expect(record.dshHome).toEqual(['C:\\old-home', 'C:\\new-home'])
  })

  it('marks an installer seed incomplete when the first launch discovers a custom root', async () => {
    const appDataDir = await freshAppDataDir()
    const recordPath = join(appDataDir, PATH_HISTORY_FILE)
    const customRoot = join(appDataDir, 'legacy-custom-root')
    const legacyHome = join(customRoot, 'Cache', 'shared-home')
    const session = join(legacyHome, 'sessions.jsonl')
    await mkdir(legacyHome, { recursive: true })
    await writeFile(join(customRoot, 'desktop-preferences.json'), '{}')
    await writeFile(session, 'retained session\n')
    await writeFile(recordPath, 'complete=1\r\n')
    const record = await mergeLaunchPathHistory({
      appDataDir, defaultUserData: join(appDataDir, 'Rivetdeck'), userData: customRoot,
      dshHome: join(appDataDir, 'current-home'),
    })
    expect(record.complete).toBe(false)
    expect(record.userData).toEqual([customRoot])
    expect(record.dshHome).not.toContain(legacyHome)
    expect(parsePathHistory(await readFile(recordPath, 'utf8'))).toEqual(record)
    expect(await readFile(session, 'utf8')).toBe('retained session\n')
  })

  it('compares recorded roots using the host filesystem casing rules', async () => {
    const appDataDir = await freshAppDataDir()
    await writeFile(join(appDataDir, PATH_HISTORY_FILE), 'complete=1\r\nuserData=C:\\Known\r\n')
    const record = await mergeLaunchPathHistory({
      appDataDir, defaultUserData: 'C:\\default', userData: 'c:\\known', dshHome: 'C:\\home',
    })
    expect(record.complete).toBe(process.platform === 'win32')
    expect(record.userData).toHaveLength(process.platform === 'win32' ? 1 : 2)
  })

  it('keeps history incomplete after discovering a custom root and returning to a known root', async () => {
    const appDataDir = await freshAppDataDir()
    await writeFile(join(appDataDir, PATH_HISTORY_FILE), 'complete=1\r\nuserData=C:\\first\r\n')
    const record = await mergeLaunchPathHistory({
      appDataDir,
      defaultUserData: 'C:\\first',
      userData: 'D:\\second',
      dshHome: 'D:\\home',
    })
    expect(record?.complete).toBe(false)
    expect(record?.userData).toEqual(['C:\\first', 'D:\\second'])
    const returned = await mergeLaunchPathHistory({
      appDataDir, defaultUserData: 'C:\\first', userData: 'C:\\first', dshHome: 'C:\\home',
    })
    expect(returned.complete).toBe(false)
    expect(returned.userData).toEqual(record.userData)
    expect(returned.dshHome).toEqual(['D:\\home', 'C:\\home'])
  })

  it('accumulates duplicate roots once', async () => {
    const appDataDir = await freshAppDataDir()
    const options = { appDataDir, defaultUserData: 'C:\\default', userData: 'C:\\same', dshHome: 'C:\\same-home' }
    await mergeLaunchPathHistory(options)
    const record = await mergeLaunchPathHistory(options)
    expect(record?.userData).toEqual(['C:\\same'])
  })

  it('retains both launches when independent processes contend for the history', async () => {
    const appDataDir = await freshAppDataDir()
    const recordPath = join(appDataDir, PATH_HISTORY_FILE)
    await writeFile(recordPath, 'complete=1\r\nuserData=C:\\data-A\r\n')
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
      expect(stored.complete).toBe(false)
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
