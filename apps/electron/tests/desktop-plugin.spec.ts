import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const electronRoot = fileURLToPath(new URL('..', import.meta.url))

const npmThemeStudioRoot = join(electronRoot, 'node_modules', '@dsh-electron', 'dsh-theme-studio')

describe('directory picker feature plugin regression', () => {
  it('injects the desktop capability service instead of reading window.deepseekDesktop directly', () => {
    const source = readFileSync(
      join(electronRoot, 'runtime', 'plugins', 'ui-directory-picker-electron', 'src', 'client', 'index.ts'),
      'utf8',
    )
    expect(source).toContain("'desktop'")
    expect(source).toContain('ctx.desktop.dialog.pickDirectory')
    expect(source).not.toContain('window?.deepseekDesktop')
    expect(source).not.toContain('ipcRenderer')
  })

  it('registers both workspace directory-flow slots', () => {
    const source = readFileSync(
      join(electronRoot, 'runtime', 'plugins', 'ui-directory-picker-electron', 'src', 'client', 'index.ts'),
      'utf8',
    )
    expect(source).toContain('conversation.hero.workspace.directoryFlow')
    expect(source).toContain('sidebar.workspaces.directoryFlow')
  })

  it('declares desktop capabilities as a client dependency', () => {
    const manifest = JSON.parse(
      readFileSync(join(electronRoot, 'runtime', 'plugins', 'ui-directory-picker-electron', 'package.json'), 'utf8'),
    ) as { dsh?: { client?: { inject?: string[] } } }
    expect(manifest.dsh?.client?.inject).toContain('@dsh-electron/dsh-electron-desktop-capabilities')
  })
})

describe('desktop brand feature plugin regression', () => {
  it('always registers brand slots without gating on DSH_CLIENT_BUILD_PROFILE', () => {
    const source = readFileSync(
      join(electronRoot, 'runtime', 'plugins', 'ui-brand-electron', 'src', 'client', 'index.ts'),
      'utf8',
    )
    expect(source).toContain('sidebar.brand.mark')
    expect(source).toContain('sidebar.brand.name')
    expect(source).toContain('conversation.hero.brand.mark')
    expect(source).not.toContain('DSH_CLIENT_BUILD_PROFILE')
  })

  it('declares ui-primitives as a client external and brand declarers as inject edges', () => {
    const manifest = JSON.parse(
      readFileSync(join(electronRoot, 'runtime', 'plugins', 'ui-brand-electron', 'package.json'), 'utf8'),
    ) as { name?: string; dsh?: { client?: { inject?: string[]; external?: string[] } } }
    expect(manifest.name).toBe('@dsh-electron/dsh-electron-ui-brand')
    expect(manifest.dsh?.client?.inject).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-sidebar',
    ]))
    expect(manifest.dsh?.client?.external).toContain('@deepseek-ai/dsh-client-ui-primitives')
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
    expect(manifest.version).toBe('0.1.1')
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
    expect(typeof plugin?.exported.apply).toBe('function')
  })
})

describe('production runtime plugin packaging inventory', () => {
  it('includes built artifacts for every bundled production plugin and excludes test fixtures', () => {
    const pluginsRoot = join(electronRoot, 'runtime', 'plugins')
    const fixtureRoot = join(electronRoot, 'tests', 'fixtures', 'runtime-plugins')
    expect(fixtureRoot.startsWith(join(electronRoot, 'tests'))).toBe(true)

    for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pluginRoot = join(pluginsRoot, entry.name)
      expect(existsSync(join(pluginRoot, 'package.json'))).toBe(true)
      expect(existsSync(join(pluginRoot, 'lib', 'index.js'))).toBe(true)
      const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as {
        dsh?: { client?: unknown }
        exports?: Record<string, { default?: string }>
      }
      if (manifest.dsh?.client !== undefined) {
        const clientTarget = manifest.exports?.['./client']?.default ?? './lib/client.js'
        expect(existsSync(join(pluginRoot, clientTarget))).toBe(true)
      }
    }
    expect(existsSync(join(electronRoot, 'runtime', 'host.patch.yml'))).toBe(true)
  })
})
