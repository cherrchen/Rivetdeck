import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cordisConfigFiles, readCordisConfig } from './cordis-config-files.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cordisConfigFiles', () => {
  it('finds Loader YAML without treating translation records as configs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-config-files-'))
    roots.push(root)
    for (const directory of ['.claude', 'apps/cli/config/examples', 'docs', 'node_modules/pkg', 'vendor/pkg']) {
      mkdirSync(join(root, directory), { recursive: true })
    }
    for (const file of [
      '.claude/hidden.cordis.yml',
      'docs/cordis-primer.i18n.yaml',
      'apps/cli/config/examples/agent.cordis.yaml',
      'apps/cli/config/examples/headless.cordis.yml',
      'node_modules/pkg/hidden.cordis.yml',
      'vendor/pkg/hidden.cordis.yml',
    ]) {
      writeFileSync(join(root, file), '[]\n')
    }

    expect(cordisConfigFiles(root)).toEqual([
      join('apps', 'cli', 'config', 'examples', 'agent.cordis.yaml'),
      join('apps', 'cli', 'config', 'examples', 'headless.cordis.yml'),
    ])
  })
})

describe('readCordisConfig', () => {
  it('reads a Git symlink checked out as a regular Windows file and rejects cycles', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-links-'))
    roots.push(root)
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: './target.yml', encoding: 'utf8' }).trim()
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${blob},cordis.yml`], { cwd: root })
    writeFileSync(join(root, 'cordis.yml'), 'target.yml')
    writeFileSync(join(root, 'target.yml'), '[]\n')
    expect(readCordisConfig(root, 'cordis.yml')).toBe('[]\n')
    writeFileSync(join(root, 'cordis.yml'), '../outside.yml')
    expect(() => readCordisConfig(root, 'cordis.yml')).toThrow('escapes repository')
    writeFileSync(join(root, 'cordis.yml'), './cordis.yml')
    expect(() => readCordisConfig(root, 'cordis.yml')).toThrow('Cyclic')
  })

  it('leaves an ordinary scalar YAML file for the entry-array validator to reject', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-scalar-'))
    roots.push(root)
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    writeFileSync(join(root, 'cordis.yml'), './missing.yml')
    expect(readCordisConfig(root, 'cordis.yml')).toBe('./missing.yml')
  })
})
