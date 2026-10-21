import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PATH_HISTORY_FILE } from '../src/path-history.ts'

const electron = vi.hoisted(() => ({
  paths: new Map<string, string>(),
  quit: vi.fn(),
  showErrorBox: vi.fn(),
  handle: vi.fn(),
}))

// Exercise Windows startup without changing the worker's process-global platform.
vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:process')>()
  return { ...actual, default: { ...globalThis.process, platform: 'win32' } }
})
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    name: 'Rivetdeck',
    getAppPath: () => resolve('apps/electron'),
    getPath: (name: string) => {
      const path = electron.paths.get(name)
      if (path === undefined) throw new Error(`Unexpected app path: ${name}`)
      return path
    },
    on: vi.fn(),
    commandLine: { getSwitchValue: () => '' },
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    quit: electron.quit,
  },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: electron.handle },
  dialog: { showErrorBox: electron.showErrorBox },
}))
vi.mock('../src/atomic-file.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/atomic-file.ts')>(),
  writeDesktopFileAtomic: vi.fn().mockRejectedValue(new Error('history write rejected')),
}))

it('stops packaged startup before services or homes are opened when history cannot be persisted', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'history-startup-'))
  const original = 'complete=1\r\ndshHome=C:\\previous-home\r\n'
  const recordPath = join(scratch, PATH_HISTORY_FILE)
  electron.paths.set('appData', scratch)
  electron.paths.set('userData', join(scratch, 'userData'))
  electron.paths.set('home', join(scratch, 'home'))
  try {
    await writeFile(recordPath, original)
    await import('../src/main.ts')
    await vi.waitFor(() => { expect(electron.quit).toHaveBeenCalledOnce() })
    expect(electron.showErrorBox).toHaveBeenCalledWith('Rivetdeck failed to start', 'history write rejected')
    expect(electron.handle).not.toHaveBeenCalled()
    expect(await readFile(recordPath, 'utf8')).toBe(original)
    await expect(readFile(join(scratch, 'userData', 'desktop-preferences.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
