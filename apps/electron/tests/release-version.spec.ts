import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const scriptsRoot = fileURLToPath(new URL('../scripts/', import.meta.url))
const restoreAgentsScript = join(scriptsRoot, 'restore-agents-downstream.mjs')

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Electron release version scripts', () => {
  it('sets the Electron manifest version from a tag or bare semver', async () => {
    const root = await createElectronFixture({
      'apps/electron/package.json': JSON.stringify({ name: '@dsh-electron/dsh-electron', version: '0.1.0-rc.1' }, null, 2),
    })
    const setVersionScript = join(root, 'apps/electron/scripts/set-version.mjs')

    execFileSync('node', [setVersionScript, 'v0.1.0-beta.2'], { cwd: root, encoding: 'utf8' })
    const manifest: unknown = JSON.parse(await readFile(join(root, 'apps/electron/package.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: '0.1.0-beta.2' })
  })

  it('syncs bundled runtime plugin manifests to the same version', async () => {
    const root = await createElectronFixture({
      'apps/electron/package.json': JSON.stringify({ name: '@dsh-electron/dsh-electron', version: '0.1.0-rc.1' }, null, 2),
      'apps/electron/runtime/plugins/alpha/package.json': JSON.stringify({ name: '@dsh-electron/alpha', version: '0.0.1' }, null, 2),
      'apps/electron/runtime/plugins/beta/package.json': JSON.stringify({ name: '@dsh-electron/beta', version: '0.1.0-beta.2' }, null, 2),
      'apps/electron/runtime/plugins/stray-file.txt': 'not a plugin',
    })
    const setVersionScript = join(root, 'apps/electron/scripts/set-version.mjs')

    execFileSync('node', [setVersionScript, '0.1.0-beta.2'], { cwd: root, encoding: 'utf8' })
    const alpha: unknown = JSON.parse(await readFile(join(root, 'apps/electron/runtime/plugins/alpha/package.json'), 'utf8'))
    const beta: unknown = JSON.parse(await readFile(join(root, 'apps/electron/runtime/plugins/beta/package.json'), 'utf8'))
    expect(alpha).toMatchObject({ version: '0.1.0-beta.2' })
    expect(beta).toMatchObject({ version: '0.1.0-beta.2' })
  })

  it('restores the AGENTS.downstream.md reference after upstream AGENTS.md sync', async () => {
    const root = await createFixture({
      'AGENTS.md': '# AGENTS.md\n\nUpstream body.\n',
    })

    execFileSync('node', [join(root, 'apps/electron/scripts/restore-agents-downstream.mjs')], { cwd: root, encoding: 'utf8' })
    const content = await readFile(join(root, 'AGENTS.md'), 'utf8')
    expect(content.trimEnd()).toBe('# AGENTS.md\n\nUpstream body.\n\n@AGENTS.downstream.md')
  })
})

async function createElectronFixture(files: Record<string, string>): Promise<string> {
  const root = await createFixture(files)
  const scriptDir = join(root, 'apps/electron/scripts')
  await mkdir(scriptDir, { recursive: true })
  await copyFile(join(scriptsRoot, 'set-version.mjs'), join(scriptDir, 'set-version.mjs'))
  return root
}

async function createFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-electron-version-'))
  tempRoots.push(root)
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${contents.trimEnd()}\n`)
  }
  const scriptDir = join(root, 'apps/electron/scripts')
  await mkdir(scriptDir, { recursive: true })
  await copyFile(restoreAgentsScript, join(scriptDir, 'restore-agents-downstream.mjs'))
  return root
}
