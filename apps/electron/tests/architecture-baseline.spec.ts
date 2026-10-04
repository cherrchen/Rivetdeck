import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const electronRoot = fileURLToPath(new URL('..', import.meta.url))

describe('runtime plugin architecture baselines', () => {
  it('keeps bundled plugins under runtime/plugins', () => {
    expect(existsSync(join(electronRoot, 'runtime', 'plugins'))).toBe(true)
  })

  it('keeps renderer/main.ts as a thin bootstrap without feature plugin imports', () => {
    const source = readFileSync(join(electronRoot, 'src', 'renderer', 'main.ts'), 'utf8')
    expect(source).toContain('installDesktopWebSocket')
    expect(source).toContain('installDesktopClipboardShim')
    expect(source).toContain('installHostBootstrap')
    expect(source).toContain('AppWebEntry')
    expect(source).not.toContain('runtime/plugins')
    expect(source).not.toContain('dsh-electron-desktop-capabilities')
  })

  it('does not modify upstream CLI or boot packages', () => {
    const root = join(electronRoot, '..', '..')
    const diff = spawnSync('git', ['diff', 'dsh-v0.2.0-rc.2', '--', 'apps/cli', 'packages/boot'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(diff.status).toBe(0)
    expect(diff.stdout).toBe('')
  })

})
