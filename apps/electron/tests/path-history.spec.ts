import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PATH_HISTORY_FILE,
  mergeLaunchPathHistory,
  parsePathHistory,
  renderPathHistory,
} from '../src/path-history.ts'

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
    const appDataDir = await mkdtemp(join(tmpdir(), 'path-history-appdata-'))
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
    const appDataDir = await mkdtemp(join(tmpdir(), 'path-history-appdata-'))
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
    const appDataDir = await mkdtemp(join(tmpdir(), 'path-history-appdata-'))
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
    const appDataDir = await mkdtemp(join(tmpdir(), 'path-history-appdata-'))
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
    const appDataDir = await mkdtemp(join(tmpdir(), 'path-history-appdata-'))
    await mergeLaunchPathHistory({ appDataDir, userData: 'C:\\same', dshHome: 'C:\\same-home' })
    const record = await mergeLaunchPathHistory({ appDataDir, userData: 'C:\\same', dshHome: 'C:\\same-home' })
    expect(record?.userData).toEqual(['C:\\same'])
  })
})
