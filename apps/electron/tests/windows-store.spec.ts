import { mkdtemp, readFile, rm, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { prepareWindowsStore, validateStoreIdentity } from '../scripts/prepare-windows-store.mjs'
import { usesStoreUpdates } from '../src/manifest.ts'
import { en, zh } from '../src/locale.ts'
import { microsoftStoreUpdateMenu } from '../src/store-update-menu.ts'

const root = join(import.meta.dirname, '..')
const identity = JSON.parse(await readFile(join(root, 'windows-store.json'), 'utf8')) as ReturnType<typeof validateStoreIdentity>
const require = createRequire(join(root, 'package.json'))
const builderRequire = createRequire(require.resolve('electron-builder'))
const { validateConfiguration } = builderRequire('app-builder-lib/out/util/config/config.js') as {
  validateConfiguration: (config: unknown, logger: { isEnabled: boolean }) => Promise<void>
}

interface PreparedStoreConfig {
  win: { target: string[]; extraResources: Array<{ from: string; to: string }> }
  extraResources: Array<{ from: string; to: string }>
  extraMetadata: Record<string, unknown>
  appx: { customManifestPath: string }
  directories: { buildResources: string }
}

describe('Microsoft Store distribution', () => {
  it('recognizes installed packages and stamped unpacked artifacts', () => {
    expect(usesStoreUpdates({}, true)).toBe(true)
    expect(usesStoreUpdates({ distribution: 'microsoft-store' }, false)).toBe(true)
    expect(usesStoreUpdates({}, false)).toBe(false)
  })

  it('records localized Store update menus without GitHub actions', () => {
    expect({ en: microsoftStoreUpdateMenu(en), zh: microsoftStoreUpdateMenu(zh) }).toMatchInlineSnapshot(`
      {
        "en": [
          {
            "enabled": false,
            "label": "Updates managed by Microsoft Store",
          },
        ],
        "zh": [
          {
            "enabled": false,
            "label": "更新由 Microsoft Store 管理",
          },
        ],
      }
    `)
  })

  it.each(['0.2.0.0', '1.0.0.1', '65536.0.0.0', '1.65536.0.0', '1.0.65536.0', '1.0.0-beta.1', '1.0.0', '01.0.0.0'])('refuses invalid Store version %s', (version) => {
    expect(() => validateStoreIdentity({ ...identity, version })).toThrow('Store version')
  })

  it.each(['identityName', 'publisher', 'publisherDisplayName', 'version', 'productId'])('requires Partner Center field %s', (field) => {
    expect(() => validateStoreIdentity({ ...identity, [field]: '' })).toThrow(field)
  })

  it('prepares branded AppX inputs independently of NSIS and semver', async () => {
    const project = await mkdtemp(join(tmpdir(), 'rivetdeck-store-'))
    try {
      await mkdir(join(project, 'build'))
      await copyFile(join(root, 'build/icon.png'), join(project, 'build/icon.png'))
      await copyFile(join(root, 'package.json'), join(project, 'package.json'))
      await writeFile(join(project, 'windows-store.json'), JSON.stringify({ ...identity, version: '2.3.4.0', publisherDisplayName: 'Cherrchen & Software' }))
      const configPath = await prepareWindowsStore(project)
      const config = JSON.parse(await readFile(configPath, 'utf8')) as PreparedStoreConfig
      await validateConfiguration(config, { isEnabled: false })
      expect(config.win.target).toEqual(['appx'])
      expect(config.win.extraResources).toEqual([{ from: '.electron-build/core-runtime/current', to: 'core-runtime' }])
      expect(config.extraResources).toContainEqual({ from: '.electron-build/network-runtime/current', to: 'network-runtime' })
      expect(config.extraMetadata).toMatchObject({ name: 'rivetdeck', distribution: 'microsoft-store' })
      expect(config.extraMetadata).not.toHaveProperty('version')
      expect(config).toMatchObject({ beforePack: null, publish: null, extends: null })
      expect(config).not.toHaveProperty('nsis')
      expect(config.appx).toMatchObject({ applicationId: 'Rivetdeck', electronUpdaterAware: false, setBuildNumber: false })
      const manifest = await readFile(config.appx.customManifestPath, 'utf8')
      expect(manifest).toContain('Name="CherrchenSoftware.Rivetdeck"')
      expect(manifest).toContain('Version="2.3.4.0"')
      expect(manifest).toContain("Publisher='CN=927251ED-C4FA-409B-8A38-C2D78ECAA60A'")
      expect(manifest).toContain('Cherrchen &amp; Software')
      expect(manifest).toContain('ProcessorArchitecture="${arch}"')
      for (const [file, width, height] of [['StoreLogo.png', 50, 50], ['Square44x44Logo.png', 44, 44], ['Square150x150Logo.png', 150, 150], ['Wide310x150Logo.png', 310, 150]] as const) {
        expect(await sharp(join(config.directories.buildResources, 'appx', file)).metadata()).toMatchObject({ width, height })
      }
      const original = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')) as {
        build: { win: { target: string[] } }
      }
      expect(original.build.win.target).toEqual(['nsis'])
      expect(original).toEqual(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')))
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it('refuses invalid submission metadata before generating package inputs', async () => {
    const project = await mkdtemp(join(tmpdir(), 'rivetdeck-invalid-store-'))
    try {
      await copyFile(join(root, 'package.json'), join(project, 'package.json'))
      await writeFile(join(project, 'windows-store.json'), JSON.stringify({ ...identity, version: '0.2.0.0' }))
      await expect(prepareWindowsStore(project)).rejects.toThrow('Store version')
      await expect(readFile(join(project, '.electron-build/store/builder.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })
})
