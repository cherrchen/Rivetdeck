// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CapabilitiesComponentsSection,
  type CapabilitiesComponentsProps,
} from '../runtime/plugins/desktop-capabilities/src/client/features/plugin-manager/CapabilitiesComponents.tsx'
import { apply, inject, NS } from '../runtime/plugins/desktop-capabilities/src/client/features/plugin-manager/index.ts'
import { en } from '../runtime/plugins/desktop-capabilities/src/client/features/plugin-manager/locales.ts'
import {
  CAPABILITIES_COMPONENTS,
  OFFICIAL_ROOT_ITEMS,
} from '../runtime/plugins/desktop-capabilities/src/client/features/plugin-manager/roster.ts'
import type { ComponentRuntimeMap } from '../runtime/plugins/desktop-capabilities/src/client/features/plugin-manager/runtime.ts'

afterEach(() => {
  cleanup()
})

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

const t: TranslateNS<'plugins.desktopRequired'> = (key, params) => interpolate(en[key], params)

function bindRuntimes(map: ComponentRuntimeMap | null): CapabilitiesComponentsProps['useRuntimes'] {
  return sel => sel(map)
}

function section(subject: CapabilitiesComponentsProps['subject'], runtimes: ComponentRuntimeMap | null = null) {
  return render(createElement(CapabilitiesComponentsSection, {
    subject, t, useRuntimes: bindRuntimes(runtimes),
  } as CapabilitiesComponentsProps))
}

function allRunning(): ComponentRuntimeMap {
  return Object.fromEntries(
    CAPABILITIES_COMPONENTS.map(component => [component.id, { enabled: true, phase: 'active' as const }]),
  )
}

describe('Desktop Plugin Manager presentation', () => {
  it('registers only Desktop Capabilities and Theme Studio as Electron-owned Official items', () => {
    expect(OFFICIAL_ROOT_ITEMS.map(item => item.id)).toEqual(['desktop-capabilities', 'theme-studio'])
  })

  it('lists five Capabilities components and omits the plugin-manager feature', () => {
    expect(CAPABILITIES_COMPONENTS.map(component => component.id)).toEqual([
      'network-subprocess',
      'directory-picker-backend',
      'directory-picker',
      'brand',
      'network-settings',
    ])
    expect(CAPABILITIES_COMPONENTS.map(component => component.id)).not.toContain('plugin-manager')
  })

  it('injects slots, locale, and pluginInventory, then releases Official items and the Components section on dispose', async () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginInventory'])
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    new TestRemote(ctx, {
      pluginInventory: { list: vi.fn(async () => ({ ok: true as const, value: { entries: [] } })) },
    })
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'plugins.item': { kind: 'list', scope: 'root' },
        'plugins.detail.section': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    const fiber = await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('plugins.item').map(entry => entry.options.id)).toEqual([
      'desktop-capabilities',
      'theme-studio',
    ])
    expect(slots.entries('plugins.detail.section')[0]?.options.id).toBe('desktop-capabilities-components')
    expect(slots.entries('plugins.detail.section')[0]?.locale).toBe(NS)
    await fiber.dispose()
    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(slots.entries('plugins.detail.section')).toHaveLength(0)
  })

  it('renders the contained-components count and five read-only rows before runtimes arrive', () => {
    section({ kind: 'item', id: 'desktop-capabilities' })
    expect(screen.getByRole('heading', { name: en.components, level: 4 })).toBeTruthy()
    expect(screen.getByText(interpolate(en.countTotal, { count: String(CAPABILITIES_COMPONENTS.length) }))).toBeTruthy()
    expect(screen.queryByText(interpolate(en.countOff, { count: String(CAPABILITIES_COMPONENTS.length) }))).toBeNull()
    expect(screen.queryByText(en.partOff)).toBeNull()
    const rows = screen.getAllByRole('listitem')
    expect(rows.map(item => item.getAttribute('data-plugin-row'))).toEqual([
      'network-subprocess',
      'directory-picker-backend',
      'directory-picker',
      'brand',
      'network-settings',
    ])
    for (const component of CAPABILITIES_COMPONENTS) {
      expect(screen.getByText(en[component.labelKey])).toBeTruthy()
      expect(screen.getByText(component.id)).toBeTruthy()
    }
    expect(screen.getByText('@dsh-electron/dsh-electron-network-subprocess')).toBeTruthy()
    expect(screen.getByText('@deepseek-ai/dsh-host-directory-picker-browse')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    cleanup()

    const theme = section({ kind: 'item', id: 'theme-studio' })
    expect(theme.container.firstChild).toBeNull()
    theme.unmount()

    const bundle = section({
      kind: 'bundle',
      pkg: { name: '@dsh-electron/dsh-theme-studio', installed: true, enabled: true, rows: [] },
    })
    expect(bundle.container.firstChild).toBeNull()
  })

  it('shows running from live runtimes and keeps rows unswitchable', () => {
    section({ kind: 'item', id: 'desktop-capabilities' }, allRunning())
    const count = String(CAPABILITIES_COMPONENTS.length)
    expect(screen.getByText(
      `${interpolate(en.countTotal, { count })} · ${interpolate(en.countRunning, { count })}`,
    )).toBeTruthy()
    expect(screen.getAllByText(en.rowPhaseActive)).toHaveLength(CAPABILITIES_COMPONENTS.length)
    expect(screen.queryByText(en.partOff)).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    for (const row of screen.getAllByRole('listitem')) {
      expect(row.getAttribute('data-state')).toBeNull()
    }
  })

  it('marks a failed observed row without treating unread rows as off', () => {
    const runtimes: ComponentRuntimeMap = {
      'network-subprocess': { enabled: true, phase: 'failed' },
    }
    section({ kind: 'item', id: 'desktop-capabilities' }, runtimes)
    expect(screen.getByText(
      `${interpolate(en.countTotal, { count: String(CAPABILITIES_COMPONENTS.length) })} · ${interpolate(en.countFailed, { count: '1' })}`,
    )).toBeTruthy()
    expect(screen.getByText(en.rowPhaseFailed)).toBeTruthy()
    expect(screen.getAllByRole('listitem')[0]?.getAttribute('data-state')).toBe('failed')
    expect(screen.getAllByRole('listitem')[1]?.getAttribute('data-state')).toBeNull()
    expect(screen.queryByText(en.partOff)).toBeNull()
  })
})
