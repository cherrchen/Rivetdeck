import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ElectronManifest {
  dependencies?: Record<string, string>
  dshElectron?: { runtimePlugins?: string[]; ecosystemPlugins?: string[] }
  build: {
    extraMetadata: { name: string }
    extraResources: Array<{ from: string; to: string }>
    nsis: { useZip: boolean; differentialPackage: boolean }
    win: { extraResources?: Array<{ from: string; to: string }> }
  }
}

describe('Electron packaging', () => {
  it('uses checked Windows extraction and an unscoped packaged identity', async () => {
    const manifestPath = join(import.meta.dirname, '..', 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ElectronManifest

    expect(manifest.build.nsis.useZip).toBe(true)
    expect(manifest.build.nsis.differentialPackage).toBe(false)
    expect(manifest.build.extraMetadata.name).toBe('deepseek-harness-desktop')
  })

  it('keeps managed distributions out of installers and ships only the Windows Core executor', async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as ElectronManifest
    expect(manifest.build.extraResources.some(resource => resource.to.startsWith('toolchains'))).toBe(false)
    expect(manifest.build.win.extraResources).toEqual([{ from: '.electron-build/core-runtime/current', to: 'core-runtime' }])
  })

  it('ships the prepared Network Runtime from an application-owned resource path', async () => {
    const manifestPath = join(import.meta.dirname, '..', 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ElectronManifest

    expect(manifest.build.extraResources).toContainEqual({
      from: '.electron-build/network-runtime/current',
      to: 'network-runtime',
    })
  })

  it('installs every declared bundled plugin as an exact production registry dependency', async () => {
    const electronRoot = join(import.meta.dirname, '..')
    const manifest = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8')) as ElectronManifest
    const names = [
      ...(manifest.dshElectron?.runtimePlugins ?? []),
      ...(manifest.dshElectron?.ecosystemPlugins ?? []),
    ]
    for (const name of names) {
      expect(manifest.dependencies?.[name]).toBeDefined()
      expect(manifest.dependencies?.[name]).not.toMatch(/^workspace:/)
      expect(existsSync(join(electronRoot, 'node_modules', ...name.split('/'), 'package.json'))).toBe(true)
    }
    expect(manifest.dependencies?.['@dsh-electron/dsh-plugin-git']).toBe('0.2.4')
    expect(manifest.dependencies?.['@dsh-electron/dsh-theme-studio']).toBe('0.1.3')
  })
})

it('generates checked Windows ZIP extraction without copying maintained installer policy', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { default: prepare, prepareWindowsInstallerScript } = await import('../scripts/prepare-windows-installer.mjs')
  const projectDir = await mkdtemp(join(tmpdir(), 'dsh-nsis-'))
  try {
    await prepare({ electronPlatformName: 'darwin', packager: { projectDir } })
    expect(existsSync(join(projectDir, '.electron-build/nsis'))).toBe(false)
    await prepareWindowsInstallerScript(projectDir, join(projectDir, '7za.exe'))
    const extraction = await readFile(join(projectDir, '.electron-build/nsis/extractAppPackage.nsh'), 'utf8')
    expect(extraction).toContain('nsExec::ExecToLog')
    expect(extraction).toContain('-aoa -y')
    expect(extraction).toContain('StrCmp $R0 "0" +4')
    expect(extraction).toContain('$(decompressionFailed)')
    expect(extraction).toContain('SetErrorLevel 1')
    expect(extraction).not.toContain('nsisunz::Unzip')
    const script = await readFile(join(projectDir, '.electron-build/nsis/installer.nsi'), 'utf8')
    expect(script).toContain('installSection.nsh')
    expect(script).toContain('!include "uninstaller.nsh"')
  } finally { await rm(projectDir, { recursive: true, force: true }) }
})
