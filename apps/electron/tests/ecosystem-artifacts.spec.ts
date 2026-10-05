/** Behavior acceptance for the published ecosystem artifacts used by Desktop. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitService } from '@dsh-electron/dsh-plugin-git'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type * as GitClient from '@dsh-electron/dsh-plugin-git/client'
import type * as ThemeClient from '@dsh-electron/dsh-theme-studio/client'

function clientArtifact(name: '@dsh-electron/dsh-plugin-git'): typeof GitClient
function clientArtifact(name: '@dsh-electron/dsh-theme-studio'): typeof ThemeClient
function clientArtifact(name: string): typeof GitClient | typeof ThemeClient {
  const captured: { factory?: (require: (id: string) => object) => typeof GitClient | typeof ThemeClient } = {}
  const path = fileURLToPath(new URL(`../node_modules/${name}/lib/client.js`, import.meta.url))
  runInNewContext(readFileSync(path, 'utf8'), { window: { __ModuleLoader__: {
    load(registration: { id: string; factory: (require: (id: string) => object) => typeof GitClient | typeof ThemeClient }) {
      expect(registration.id).toBe(name)
      captured.factory = registration.factory
    },
  } } })
  if (captured.factory === undefined) throw new Error('Client artifact did not register its factory')
  return captured.factory((id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return jsx
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`Unexpected client dependency: ${id}`)
  })
}

it('runs Git status, staging, diffs, commits, history, and branches from the published Host artifact', async () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-git-acceptance-')))
  onTestFinished(() => { rmSync(repository, { recursive: true, force: true }) })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' })
  git('init', '-b', 'main')
  git('config', 'user.name', 'Desktop acceptance')
  git('config', 'user.email', 'desktop-acceptance@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(repository, 'empty-hooks'))
  git('config', 'core.hooksPath', join(repository, 'empty-hooks'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LocalSubprocessRuntime).await()
  const service = new GitService(ctx.subprocess, { executable: 'git', maxOutputBytes: 1048576, graceMs: 1000 })
  const discovered = await service.discover(repository)
  // Native realpath resolves Windows short names and Git's forward slashes to the same directory.
  expect(discovered === null ? null : realpathSync.native(discovered)).toBe(realpathSync.native(repository))
  writeFileSync(join(repository, 'example.txt'), 'first\n')
  expect((await service.status(repository)).untracked).toContain('example.txt')
  expect((await service.stage(repository)).staged.map(change => change.path)).toContain('example.txt')
  expect((await service.diff(repository, true)).text).toContain('+first')
  await service.commit(repository, 'Initial acceptance commit')
  expect((await service.log(repository, 10, 0))[0]?.subject).toBe('Initial acceptance commit')
  writeFileSync(join(repository, 'example.txt'), 'second\n')
  expect((await service.diff(repository, false)).text).toContain('+second')
  await service.stage(repository)
  expect((await service.unstage(repository)).unstaged.map(change => change.path)).toContain('example.txt')
  await service.createBranch(repository, 'acceptance')
  expect((await service.switchBranch(repository, 'acceptance')).branch).toBe('acceptance')
})

it('loads the portable Git Client artifact with the current right-sidebar services', () => {
  const client = clientArtifact('@dsh-electron/dsh-plugin-git')
  expect(client.inject).toEqual(expect.arrayContaining(['slots', 'connection', 'locale', 'sidebarRight', 'sidebarRightTabs']))
  expect(client.inject).not.toContain('desktop')
  expect(client.inject).not.toContain('shellDetails')
  for (const component of [client.GitChangesSurface, client.GitDiffSurface, client.GitGraphSurface]) {
    expect(typeof component).toBe('function')
  }
})

it('previews Theme Studio without persistence and persists applied themes from the published Client artifact', async () => {
  const client = clientArtifact('@dsh-electron/dsh-theme-studio')
  const layers = new Set<string>()
  const write = vi.fn(async (_field: string, _value: unknown) => {})
  const runtime = new client.ThemeStudioRuntime({
    theme: { overrideTokens(source) { layers.add(source); return () => { layers.delete(source) } } },
    host: { getSnapshot: () => ({ status: 'ready', value: { activeThemeId: null } }), subscribe: () => () => {}, set: write },
    catalog: new client.BuiltinPresetRegistry(),
  })
  onTestFinished(() => { runtime.dispose() })
  const theme = client.BUILTIN_PRESETS[0]
  if (theme === undefined) throw new Error('Published theme catalog is empty')
  runtime.previewTheme(theme.id)
  expect(runtime.getSnapshot().previewing).toBe(true)
  expect(layers.has(client.PREVIEW_SOURCE)).toBe(true)
  expect(write).not.toHaveBeenCalled()
  runtime.cancelPreview()
  expect(layers.size).toBe(0)
  runtime.previewTheme(theme.id)
  runtime.applyPreview()
  await Promise.resolve()
  expect(write).toHaveBeenCalledWith('activeThemeId', theme.id)
  expect(layers.has(client.ACTIVE_SOURCE)).toBe(true)
  expect(layers.has(client.PREVIEW_SOURCE)).toBe(false)
  runtime.restoreDefault()
  await Promise.resolve()
  expect(write).toHaveBeenLastCalledWith('activeThemeId', null)
  expect(layers.size).toBe(0)
})
