import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { preparePluginPackageManager } from '../src/plugin-package-manager.ts'

describe('upstream plugin manager runtime', () => {
  it('runs bundled pnpm with the packaged Node executable on Windows', async () => {
    const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-electron-pnpm-win-'))
    try {
      const pnpmBin = join(harnessHome, 'pnpm.cjs')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(pnpmBin, '')
      const runtime = preparePluginPackageManager(harnessHome, 'C:\\node\\node.exe', pnpmBin, 'C:\\Windows', 'win32')
      const shim = readFileSync(join(runtime.binDirectory, 'pnpm.cmd'), 'utf8')
      expect(shim).toContain('C:\\node\\node.exe')
      expect(shim).toContain(pnpmBin)
      expect(shim).not.toContain('ELECTRON_RUN_AS_NODE')
    } finally {
      await rm(harnessHome, { recursive: true, force: true })
    }
  })

  it('places packaged pnpm on the supervised Host PATH', async () => {
    const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-electron-pnpm-'))
    try {
      const pnpmBin = join(harnessHome, 'pnpm.cjs')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(pnpmBin, '')
      const runtime = preparePluginPackageManager(harnessHome, '/bundle/bin/node', pnpmBin, '/usr/bin', 'linux')
      expect(runtime.envPath).toBe(`${runtime.binDirectory}${delimiter}/usr/bin`)
      expect(existsSync(join(runtime.binDirectory, 'pnpm'))).toBe(true)
      expect(readFileSync(join(runtime.binDirectory, 'pnpm'), 'utf8')).toContain(pnpmBin)
      expect(readFileSync(join(runtime.binDirectory, 'pnpm'), 'utf8')).toContain('/bundle/bin/node')
      expect(readFileSync(join(runtime.binDirectory, 'pnpm'), 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1')
      expect(readFileSync(join(runtime.binDirectory, 'node'), 'utf8')).toContain('/bundle/bin/node')
    } finally {
      await rm(harnessHome, { recursive: true, force: true })
    }
  })
})
