import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
    })
    expect(parsePathHistory(renderPathHistory(record))).toEqual(record)
  })

  it('marks a first-ever record incomplete', async () => {
    const { installDir, appDataDir } = await directories()
    const record = await mergeLaunchPathHistory({
      installDir, appDataDir,
      userData: 'D:\\data\\Rivetdeck',
      dshHome: 'D:\\home\\.dsh',
    })
    expect(record).toMatchObject({ complete: false })
    const stored = parsePathHistory(await readFile(join(installDir, PATH_HISTORY_FILE), 'utf8'))
    expect(stored.userData).toEqual(['D:\\data\\Rivetdeck'])
    expect(stored.dshHome).toEqual(['D:\\home\\.dsh'])
  })

  it('merges relocated roots and keeps the installer-seeded completeness', async () => {
    const { installDir, appDataDir } = await directories()
    await writeFile(join(installDir, PATH_HISTORY_FILE), 'complete=1\r\nuserData=C:\\first\r\n')
    const record = await mergeLaunchPathHistory({
      installDir, appDataDir,
      userData: 'D:\\second',
      dshHome: 'D:\\home',
    })
    expect(record?.complete).toBe(true)
    expect(record?.userData).toEqual(['C:\\first', 'D:\\second'])
  })

  it('adopts the record a replaced uninstaller migrated, then removes it', async () => {
    const { installDir, appDataDir } = await directories()
    const migrated = join(appDataDir, PATH_HISTORY_FILE)
    await writeFile(migrated, 'complete=1\r\nuserData=C:\\old-root\r\ndshHome=C:\\old-home\r\n')
    const record = await mergeLaunchPathHistory({
      installDir, appDataDir,
      userData: 'C:\\new-root',
      dshHome: 'C:\\new-home',
    })
    expect(record?.complete).toBe(true)
    expect(record?.userData).toEqual(['C:\\old-root', 'C:\\new-root'])
    expect(record?.dshHome).toEqual(['C:\\old-home', 'C:\\new-home'])
    await expect(readFile(migrated, 'utf8')).rejects.toThrow()
  })

  it('accumulates duplicate roots once', async () => {
    const { installDir, appDataDir } = await directories()
    await mergeLaunchPathHistory({ installDir, appDataDir, userData: 'C:\\same', dshHome: 'C:\\same-home' })
    const record = await mergeLaunchPathHistory({ installDir, appDataDir, userData: 'C:\\same', dshHome: 'C:\\same-home' })
    expect(record?.userData).toEqual(['C:\\same'])
  })
})

async function directories() {
  const installDir = await mkdtemp(join(tmpdir(), 'path-history-install-'))
  const appDataDir = await mkdtemp(join(tmpdir(), 'path-history-appdata-'))
  return { installDir, appDataDir }
}
