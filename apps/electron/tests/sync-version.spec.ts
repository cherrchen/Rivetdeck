import { describe, expect, it } from 'vitest'
import { nextBetaTag } from '../scripts/next-beta-tag-lib.mjs'
import {
  DESKTOP_ENTRY_WORKSPACE_DEPENDENCIES,
  assertResolvedWorkspaceDependencies,
  synchronizeDependencies,
} from '../scripts/sync-version-dependencies.mjs'

describe('Electron dependency synchronization', () => {
  it('replaces workspace dependencies and retains desktop registry dependencies', () => {
    const dependencies = synchronizeDependencies(
      {
        '@deepseek-ai/dsh-obsolete': 'workspace:^',
        'electron-updater': '^6.8.9',
      },
      ['@deepseek-ai/dsh', '@deepseek-ai/dsh-runtime'],
      new Set([
        '@deepseek-ai/dsh',
        '@deepseek-ai/dsh-obsolete',
        '@deepseek-ai/dsh-runtime',
      ]),
    )

    expect(dependencies).toEqual({
      '@deepseek-ai/dsh': 'workspace:^',
      '@deepseek-ai/dsh-runtime': 'workspace:^',
      'electron-updater': '^6.8.9',
    })
  })

  it('drops leftover workspace specifiers whose packages are absent from the workspace', () => {
    const dependencies = synchronizeDependencies(
      {
        '@deepseek-ai/dsh-client-schema-form': 'workspace:^',
        '@deepseek-ai/dsh-client-web-react': 'workspace:*',
        'electron-updater': '^6.8.9',
      },
      ['@deepseek-ai/dsh'],
      new Set(['@deepseek-ai/dsh']),
    )

    expect(dependencies).toEqual({
      '@deepseek-ai/dsh': 'workspace:^',
      'electron-updater': '^6.8.9',
    })
  })

  it('retains required desktop workspace dependencies outside the CLI graph', () => {
    const dependencies = synchronizeDependencies(
      {
        '@deepseek-ai/dsh-client-web': 'workspace:^',
        '@deepseek-ai/dsh-obsolete': 'workspace:^',
        'electron-updater': '^6.8.9',
      },
      ['@deepseek-ai/dsh'],
      new Set([
        '@deepseek-ai/dsh',
        '@deepseek-ai/dsh-client-web',
        '@deepseek-ai/dsh-obsolete',
      ]),
      DESKTOP_ENTRY_WORKSPACE_DEPENDENCIES,
    )

    expect(dependencies).toEqual({
      '@deepseek-ai/dsh': 'workspace:^',
      '@deepseek-ai/dsh-client-web': 'workspace:^',
      '@deepseek-ai/dsh-subprocess-local': 'workspace:^',
      'electron-updater': '^6.8.9',
    })
  })

  it('retains the exact registry pin for declared ecosystem plugins', () => {
    const dependencies = synchronizeDependencies(
      {
        '@dsh-electron/dsh-plugin-git': '0.2.4',
        'electron-updater': '^6.8.9',
      },
      ['@deepseek-ai/dsh'],
      new Set(['@deepseek-ai/dsh']),
      DESKTOP_ENTRY_WORKSPACE_DEPENDENCIES,
    )

    expect(dependencies).toEqual({
      '@deepseek-ai/dsh': 'workspace:^',
      '@deepseek-ai/dsh-client-web': 'workspace:^',
      '@deepseek-ai/dsh-subprocess-local': 'workspace:^',
      '@dsh-electron/dsh-plugin-git': '0.2.4',
      'electron-updater': '^6.8.9',
    })
  })

  it('rejects workspace dependencies that are absent from the workspace', () => {
    expect(() => {
      assertResolvedWorkspaceDependencies(
        { '@deepseek-ai/dsh-missing': 'workspace:^' },
        new Set(['@deepseek-ai/dsh']),
      )
    }).toThrow('Electron dependency @deepseek-ai/dsh-missing is not present in the workspace')
  })
})

describe('Electron beta tag planning', () => {
  it('increments beta.x independently within the upstream base version', () => {
    expect(nextBetaTag('0.1.0-rc.3', ['v0.1.0-beta.2', 'v0.1.0-beta.5'])).toBe('v0.1.0-beta.6')
    expect(nextBetaTag('0.1.0-rc.3', [])).toBe('v0.1.0-beta.1')
  })
})

describe('Electron beta tag planning', () => {
  it('increments beta.x independently within the upstream base version', () => {
    expect(nextBetaTag('0.1.0-rc.3', ['v0.1.0-beta.2', 'v0.1.0-beta.5'])).toBe('v0.1.0-beta.6')
    expect(nextBetaTag('0.1.0-rc.3', [])).toBe('v0.1.0-beta.1')
  })
})

describe('Electron beta tag planning', () => {
  it('increments beta.x independently within the upstream base version', () => {
    expect(nextBetaTag('0.1.0-rc.3', ['v0.1.0-beta.2', 'v0.1.0-beta.5'])).toBe('v0.1.0-beta.6')
    expect(nextBetaTag('0.1.0-rc.3', [])).toBe('v0.1.0-beta.1')
  })
})
