import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES_COMPONENTS,
  DESKTOP_CAPABILITIES_VERSION,
  OFFICIAL_ROOT_ITEMS,
} from '../runtime/plugins/desktop-capabilities/src/client/features/plugin-manager/roster.ts'

const electronRoot = fileURLToPath(new URL('..', import.meta.url))
const capabilitiesRoot = join(electronRoot, 'runtime', 'plugins', 'desktop-capabilities')
const featuresRoot = join(capabilitiesRoot, 'src', 'client', 'features')
const npmThemeStudioRoot = join(electronRoot, 'node_modules', '@dsh-electron', 'dsh-theme-studio')

const DELETED_PLUGIN_DIRS = [
  'ui-directory-picker-electron',
  'ui-brand-electron',
  'ui-network-settings-electron',
  'ui-desktop-plugins',
] as const

describe('directory picker feature plugin regression', () => {
  it('injects the desktop capability service instead of reading window.deepseekDesktop directly', () => {
    const source = readFileSync(join(featuresRoot, 'directory-picker', 'index.ts'), 'utf8')
    expect(source).toContain("'desktop'")
    expect(source).toContain('ctx.desktop.dialog.pickDirectory')
    expect(source).not.toContain('window?.deepseekDesktop')
    expect(source).not.toContain('ipcRenderer')
  })

  it('registers both workspace directory-flow slots', () => {
    const source = readFileSync(join(featuresRoot, 'directory-picker', 'index.ts'), 'utf8')
    expect(source).toContain('conversation.hero.workspace.directoryFlow')
    expect(source).toContain('sidebar.workspaces.directoryFlow')
  })
})

describe('desktop brand feature plugin regression', () => {
  it('always registers brand slots without gating on DSH_CLIENT_BUILD_PROFILE', () => {
    const source = readFileSync(join(featuresRoot, 'brand', 'index.ts'), 'utf8')
    expect(source).toContain('sidebar.brand.mark')
    expect(source).toContain('sidebar.brand.name')
    expect(source).toContain('conversation.hero.brand.mark')
    expect(source).not.toContain('DSH_CLIENT_BUILD_PROFILE')
  })
})

describe('desktop capabilities composition package', () => {
  it('declares the client inject union without immediately or a self-reference', () => {
    const manifest = JSON.parse(readFileSync(join(capabilitiesRoot, 'package.json'), 'utf8')) as {
      name?: string
      dsh?: { client?: { immediately?: boolean; inject?: string[]; external?: string[] } }
    }
    expect(manifest.name).toBe('@dsh-electron/dsh-electron-desktop-capabilities')
    expect(manifest.dsh?.client?.immediately).toBeUndefined()
    expect(manifest.dsh?.client?.inject).toEqual([
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-workspace',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-plugin-manager',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-api-remotes',
    ])
    expect(manifest.dsh?.client?.inject).not.toContain('@dsh-electron/dsh-electron-desktop-capabilities')
    expect(manifest.dsh?.client?.external).toContain('@deepseek-ai/dsh-client-ui-primitives')
  })

  it('keeps internal features out of the runtime plugin inventory', () => {
    expect(existsSync(join(featuresRoot, 'package.json'))).toBe(false)
    for (const feature of ['directory-picker', 'brand', 'network-settings', 'plugin-manager']) {
      expect(existsSync(join(featuresRoot, feature, 'package.json'))).toBe(false)
    }
  })
})

describe('theme studio published runtime plugin regression', () => {
  it('ships a web client that declares no Desktop capability edge', () => {
    const manifest = JSON.parse(readFileSync(join(npmThemeStudioRoot, 'package.json'), 'utf8')) as {
      name?: string
      version?: string
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      dsh?: { client?: { platform?: string; inject?: string[] } }
    }
    expect(manifest.name).toBe('@dsh-electron/dsh-theme-studio')
    expect(manifest.version).toBe('0.1.2')
    const dshPeers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    expect(dshPeers.length).toBeGreaterThan(0)
    for (const [, versions] of dshPeers) expect(versions.split(' || ')).toContain('0.1.7-rc.2')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.inject ?? []).not.toContain('@dsh-electron/dsh-electron-desktop-capabilities')
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('electron')
  })

  it('registers its client bundle under the package id with only the seeded external', () => {
    const bundle = readFileSync(join(npmThemeStudioRoot, 'lib', 'client.js'), 'utf8')
    const reactRuntime: unknown = createRequire(import.meta.url)('react/jsx-runtime')
    const loaded: Array<{ id: string; exported: { apply?: unknown; inject?: string[] } }> = []
    const host = globalThis as typeof globalThis & {
      window?: {
        __ModuleLoader__: {
          load: (entry: {
            id: string
            factory: (require: (specifier: string) => unknown) => { apply?: unknown; inject?: string[] }
          }) => void
        }
      }
    }
    const previousWindow = host.window
    host.window = {
      __ModuleLoader__: {
        load: (entry) => {
          loaded.push({
            id: entry.id,
            exported: entry.factory((specifier) => {
              if (specifier === 'react/jsx-runtime') return reactRuntime
              throw new Error(`unexpected client bundle external: ${specifier}`)
            }),
          })
        },
      },
    }
    try {
      runInNewContext(bundle, { window: host.window })
    } finally {
      if (previousWindow === undefined) delete host.window
      else host.window = previousWindow
    }
    const plugin = loaded.find(entry => entry.id === '@dsh-electron/dsh-theme-studio')
    expect(plugin?.exported.inject).toContain('theme')
    expect(plugin?.exported.inject).not.toContain('settingsScope')
    expect(plugin?.exported.inject).not.toContain('desktop')
    expect(typeof plugin?.exported.apply).toBe('function')
  })
})

describe('desktop plugins roster', () => {
  it('registers Desktop Capabilities without claiming the Official card is running', () => {
    const source = readFileSync(join(featuresRoot, 'plugin-manager', 'index.ts'), 'utf8')
    const card = readFileSync(join(featuresRoot, 'plugin-manager', 'DesktopPluginCard.tsx'), 'utf8')
    const locales = readFileSync(join(featuresRoot, 'plugin-manager', 'locales.ts'), 'utf8')
    const manifest = JSON.parse(readFileSync(join(capabilitiesRoot, 'package.json'), 'utf8')) as { version?: string }
    const themeManifest = JSON.parse(readFileSync(join(npmThemeStudioRoot, 'package.json'), 'utf8')) as { version?: string }
    expect(OFFICIAL_ROOT_ITEMS.map(item => item.id)).toEqual(['desktop-capabilities'])
    expect(OFFICIAL_ROOT_ITEMS.find(item => item.id === 'desktop-capabilities')?.version).toBe(DESKTOP_CAPABILITIES_VERSION)
    expect(manifest.version).toBe(DESKTOP_CAPABILITIES_VERSION)
    expect(themeManifest.version).toBe('0.1.2')
    expect(source).toContain("name: 'plugins.item'")
    expect(source).toContain("name: 'plugins.detail.badge'")
    expect(source).toContain("name: 'plugins.detail.section'")
    expect(source).toContain('remote.pluginInventory')
    expect(source).not.toContain('dsh-plugin-git')
    expect(source).not.toContain('theme-studio')
    expect(card).toContain('descriptionKey')
    expect(card).not.toMatch(/\bRunning\b/)
    expect(locales).toContain('Choose a workspace folder')
    expect(locales).not.toContain('Preview and save color themes')
    expect(locales).not.toContain('Built into Desktop')
    expect(locales).not.toContain('Required by Desktop')
    expect(locales).not.toMatch(/successfully/i)
  })

  it('lists five Capabilities components and omits the plugin-manager feature', () => {
    expect(CAPABILITIES_COMPONENTS.map(component => component.id)).toEqual([
      'network-subprocess',
      'directory-picker-backend',
      'directory-picker',
      'brand',
      'network-settings',
    ])
    expect(CAPABILITIES_COMPONENTS.some(component => component.id === 'plugin-manager')).toBe(false)
    expect(CAPABILITIES_COMPONENTS.map(component => component.moduleName)).toEqual([
      '@dsh-electron/dsh-electron-network-subprocess',
      '@deepseek-ai/dsh-host-directory-picker-browse',
      '@dsh-electron/dsh-electron-desktop-capabilities/directory-picker',
      '@dsh-electron/dsh-electron-desktop-capabilities/brand',
      '@dsh-electron/dsh-electron-desktop-capabilities/network-settings',
    ])
  })
})

describe('production runtime plugin packaging inventory', () => {
  it('includes built artifacts for capabilities and network-subprocess only', () => {
    const pluginsRoot = join(electronRoot, 'runtime', 'plugins')
    const fixtureRoot = join(electronRoot, 'tests', 'fixtures', 'runtime-plugins')
    expect(fixtureRoot.startsWith(join(electronRoot, 'tests'))).toBe(true)
    const directories = readdirSync(pluginsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    expect(directories).toEqual(['desktop-capabilities', 'desktop-network-subprocess'])
    for (const name of DELETED_PLUGIN_DIRS) expect(existsSync(join(pluginsRoot, name))).toBe(false)

    const capabilities = JSON.parse(readFileSync(join(capabilitiesRoot, 'package.json'), 'utf8')) as {
      dsh?: { client?: unknown }
    }
    expect(existsSync(join(capabilitiesRoot, 'lib', 'index.js'))).toBe(true)
    expect(existsSync(join(capabilitiesRoot, 'lib', 'client.js'))).toBe(true)
    expect(capabilities.dsh?.client).toBeDefined()

    const subprocessRoot = join(pluginsRoot, 'desktop-network-subprocess')
    const subprocess = JSON.parse(readFileSync(join(subprocessRoot, 'package.json'), 'utf8')) as {
      dsh?: { client?: unknown }
    }
    expect(existsSync(join(subprocessRoot, 'lib', 'index.js'))).toBe(true)
    expect(subprocess.dsh?.client).toBeUndefined()
    expect(existsSync(join(subprocessRoot, 'lib', 'client.js'))).toBe(false)
    expect(existsSync(join(electronRoot, 'runtime', 'host.patch.yml'))).toBe(true)
  })

  it('wraps the capabilities client bundle under the package id', () => {
    const bundle = readFileSync(join(capabilitiesRoot, 'lib', 'client.js'), 'utf8')
    expect(bundle).toContain('id: "@dsh-electron/dsh-electron-desktop-capabilities"')
  })
})
