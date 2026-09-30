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

  it('ships complete Node and Python distributions on every platform', async () => {
    const manifestPath = join(import.meta.dirname, '..', 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ElectronManifest

    expect(manifest.build.win.extraResources).toBeUndefined()
    expect(manifest.build.extraResources).toContainEqual({
      from: '.electron-build/toolchains/current/node',
      to: 'toolchains/node',
    })
    expect(manifest.build.extraResources).toContainEqual({
      from: '.electron-build/toolchains/current/python',
      to: 'toolchains/python',
    })
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
