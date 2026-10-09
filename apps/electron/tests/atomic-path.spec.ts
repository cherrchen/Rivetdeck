import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renameDesktopPath } from '../src/atomic-file.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
afterEach(async () => {
  vi.mocked(rename).mockReset().mockImplementation(actual.rename)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-rename-'))
  roots.push(root)
  const source = join(root, 'staging')
  const destination = join(root, 'installed')
  await mkdir(source)
  await writeFile(join(source, 'runtime'), 'verified')
  return { source, destination }
}

describe('Desktop generation rename', () => {
  it('commits a complete directory after transient Windows locks release', async () => {
    const { source, destination } = await fixture()
    for (const code of ['EACCES', 'EBUSY', 'EPERM']) vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('locked'), { code }))
    await renameDesktopPath(source, destination, { platform: 'win32' })
    expect(rename).toHaveBeenCalledTimes(4)
    expect(await readFile(join(destination, 'runtime'), 'utf8')).toBe('verified')
    await expect(readFile(join(source, 'runtime'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'ENOSPC']] as const) {
    it(`retains staging on ${platform} ${code} without retrying`, async () => {
      const { source, destination } = await fixture()
      vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('permanent'), { code }))
      await expect(renameDesktopPath(source, destination, { platform })).rejects.toMatchObject({ code })
      expect(rename).toHaveBeenCalledTimes(1)
      expect(await readFile(join(source, 'runtime'), 'utf8')).toBe('verified')
      await expect(readFile(join(destination, 'runtime'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }
  it('bounds repeated Windows permission failures without committing a generation', async () => {
    const { source, destination } = await fixture()
    vi.mocked(rename).mockRejectedValue(Object.assign(new Error('locked'), { code: 'EPERM' }))
    await expect(renameDesktopPath(source, destination, { platform: 'win32' })).rejects.toMatchObject({ code: 'EPERM' })
    expect(rename).toHaveBeenCalledTimes(9)
    expect(await readFile(join(source, 'runtime'), 'utf8')).toBe('verified')
    await expect(readFile(join(destination, 'runtime'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('cancels a Windows retry without moving the verified directory', async () => {
    const { source, destination } = await fixture()
    const controller = new AbortController()
    vi.mocked(rename).mockImplementationOnce(async () => {
      controller.abort()
      throw Object.assign(new Error('locked'), { code: 'EPERM' })
    })
    await expect(renameDesktopPath(source, destination, { platform: 'win32', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(rename).toHaveBeenCalledTimes(1)
    expect(await readFile(join(source, 'runtime'), 'utf8')).toBe('verified')
    await expect(readFile(join(destination, 'runtime'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
