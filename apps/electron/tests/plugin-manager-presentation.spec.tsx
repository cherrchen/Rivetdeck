// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it } from 'vitest'
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

afterEach(() => {
  cleanup()
})

const t: TranslateNS<'plugins.desktopRequired'> = key => en[key]

function section(subject: CapabilitiesComponentsProps['subject']) {
  return render(createElement(CapabilitiesComponentsSection, { subject, t } as CapabilitiesComponentsProps))
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

  it('registers Official items and the Components section, then releases both on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
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

  it('renders five Components on the Capabilities item and nothing on other subjects', () => {
    section({ kind: 'item', id: 'desktop-capabilities' })
    const names = screen.getAllByRole('listitem').map(item => item.textContent)
    expect(names).toEqual([
      'Network subprocess',
      'Directory picker backend',
      'Directory picker',
      'Brand',
      'Network settings',
    ])
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
})
