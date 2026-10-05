import { describe, expect, it } from 'vitest'
import { formatDesktopMessage, resolveDesktopMainLocale, en, zh } from '../src/locale.ts'

describe('desktop Main locale', () => {
  it('selects Chinese for zh locales and English otherwise', () => {
    expect(resolveDesktopMainLocale('zh-CN').messages).toBe(zh)
    expect(resolveDesktopMainLocale('zh-TW').id).toBe('zh-CN')
    expect(resolveDesktopMainLocale('en-US').messages).toBe(en)
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('localizes Main chrome, About, and updater product copy', () => {
    expect(formatDesktopMessage(en.menuAbout, { name: 'Rivetdeck' })).toBe('About Rivetdeck')
    expect(formatDesktopMessage(zh.menuAbout, { name: 'Rivetdeck' })).toBe('关于 Rivetdeck')
    expect(formatDesktopMessage(en.updateUpToDate, { name: 'Rivetdeck' })).toBe('Rivetdeck is up to date')
    expect(formatDesktopMessage(zh.updateUpToDate, { name: 'Rivetdeck' })).toBe('Rivetdeck 已是最新版本')
    expect(en.aboutBody).toContain('DeepSeek Harness')
    expect(zh.aboutBody).toContain('DeepSeek Harness')
  })
})
