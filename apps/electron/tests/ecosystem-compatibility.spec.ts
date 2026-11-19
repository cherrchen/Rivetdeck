/** Compatibility waivers keep a bundled ecosystem release the runtime does not declare. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { getDshRuntimeVersion, PROFILE_COMPATIBILITY_FILENAME, readProfileVersionExemptions } from '@deepseek-ai/dsh-app-boot'
import { grantCompatibilityWaivers, readCompatibilityWaivers } from '../src/ecosystem-compatibility.ts'

const appPath = fileURLToPath(new URL('..', import.meta.url))
const THEME = '@dsh-electron/dsh-theme-studio'
const GIT = '@dsh-electron/dsh-plugin-git'
const cleaned: string[] = []

afterEach(() => {
  for (const dir of cleaned.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureApp(waivers?: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-electron-waiver-'))
  cleaned.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@dsh-electron/dsh-electron',
    ...waivers === undefined ? {} : { dshElectron: { compatibilityWaivers: waivers } },
  }))
  return root
}

function fixtureProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-electron-waiver-profile-'))
  cleaned.push(dir)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('ecosystem compatibility waivers', () => {
  it('reads only exact package@version waivers from the Desktop manifest', () => {
    expect(readCompatibilityWaivers(appPath)).toEqual([
      { name: THEME, version: '0.1.7', key: `${THEME}@0.1.7` },
    ])
    expect(readCompatibilityWaivers(fixtureApp())).toEqual([])
  })

  it('rejects a waiver that is not an exact package@version pair', () => {
    expect(() => readCompatibilityWaivers(fixtureApp([THEME]))).toThrow(/exact package@version/)
    expect(() => readCompatibilityWaivers(fixtureApp([`${THEME}@`]))).toThrow(/exact package@version/)
  })

  it('grants the waiver to the profile once and stays idempotent', async () => {
    const dir = fixtureProfile()
    const waivers = readCompatibilityWaivers(appPath)
    expect(await grantCompatibilityWaivers(appPath, dir, waivers)).toEqual([`${THEME}@0.1.7`])
    expect(readProfileVersionExemptions(dir)).toEqual({ [`${THEME}@0.1.7`]: [getDshRuntimeVersion()] })
    expect(JSON.parse(readFileSync(join(dir, PROFILE_COMPATIBILITY_FILENAME), 'utf8'))).toEqual({
      [`${THEME}@0.1.7`]: [getDshRuntimeVersion()],
    })
    expect(await grantCompatibilityWaivers(appPath, dir, waivers)).toEqual([])
  })

  it('does not grant a waiver whose release already declares the bundled runtime', async () => {
    const dir = fixtureProfile()
    const waivers = [{ name: GIT, version: '0.2.14', key: `${GIT}@0.2.14` }]
    expect(await grantCompatibilityWaivers(appPath, dir, waivers)).toEqual([])
    expect(readProfileVersionExemptions(dir)).toEqual({})
  })

  it('rejects a waiver naming no bundled plugin or a different bundled release', async () => {
    const dir = fixtureProfile()
    await expect(grantCompatibilityWaivers(appPath, dir, [
      { name: '@dsh-electron/dsh-missing', version: '1.0.0', key: '@dsh-electron/dsh-missing@1.0.0' },
    ])).rejects.toThrow(/names no bundled ecosystem plugin/)
    await expect(grantCompatibilityWaivers(appPath, dir, [
      { name: THEME, version: '0.1.6', key: `${THEME}@0.1.6` },
    ])).rejects.toThrow(/but the bundled release is/)
  })
})
