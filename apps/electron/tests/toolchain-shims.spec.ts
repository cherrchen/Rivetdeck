import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareToolchainShims } from '../src/toolchains/shims.ts'

describe('Desktop fallback shims', () => {
  it.runIf(process.platform !== 'win32')('uses exact executables and writable package locations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-toolchain-shims-'))
    try {
      const node = join(root, 'node')
      const python = join(root, 'python')
      writeFileSync(node, '#!/bin/sh\nprintf "%s|%s|%s\\n" "$0" "$NPM_CONFIG_PREFIX" "$*"\n', { mode: 0o700 })
      writeFileSync(python, '#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$0" "$PYTHONUSERBASE" "$PIP_USER" "$*"\n', { mode: 0o700 })
      chmodSync(node, 0o700)
      chmodSync(python, 0o700)
      const paths = prepareToolchainShims(root, {
        node: { executable: node, version: '24.17.0' },
        python: { executable: python, version: '3.14.7' },
        nodeBinDirectory: root, pythonBinDirectory: root,
        npmCli: join(root, 'npm-cli.js'), npxCli: join(root, 'npx-cli.js'),
      }, 'darwin')
      expect(paths.nodeGlobalBinDirectory).toBe(join(root, 'electron', 'node-global', 'bin'))
      expect(paths.pythonUserBinDirectory).toBe(join(root, 'electron', 'python-user', 'bin'))
      const baseEnv = { PATH: process.env.PATH ?? '' }
      const pip = execFileSync(join(paths.shimDirectory, 'pip'), ['install', 'example'], { encoding: 'utf8', env: baseEnv })
      expect(pip).toContain(`${python}|${paths.pythonUserBase}|1|-m pip install example`)
      const npm = execFileSync(join(paths.shimDirectory, 'npm'), ['--version'], { encoding: 'utf8', env: baseEnv })
      expect(npm).toContain(`${node}|${join(root, 'electron', 'node-global')}|${join(root, 'npm-cli.js')} --version`)
      const custom = execFileSync(join(paths.shimDirectory, 'python'), [], {
        encoding: 'utf8', env: { ...baseEnv, PYTHONUSERBASE: '/custom/python' },
      })
      expect(custom).toContain(`${python}|/custom/python||`)
      const pythonPip = execFileSync(join(paths.shimDirectory, 'python'), ['-m', 'pip', 'install', 'example'], {
        encoding: 'utf8', env: baseEnv,
      })
      expect(pythonPip).toContain(`${python}|${paths.pythonUserBase}|1|-m pip install example`)
      const venv = execFileSync(join(paths.shimDirectory, 'python'), ['-m', 'venv', '.venv'], {
        encoding: 'utf8', env: baseEnv,
      })
      expect(venv).toContain(`${python}|${paths.pythonUserBase}||-m venv .venv`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes Windows npm and pip commands against their exact runtimes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-toolchain-win-shims-'))
    try {
      const paths = prepareToolchainShims(root, {
        node: { executable: 'C:\\bundle\\node.exe', version: '24.17.0' },
        python: { executable: 'C:\\bundle\\python.exe', version: '3.14.7' },
        nodeBinDirectory: 'C:\\bundle', pythonBinDirectory: 'C:\\bundle',
        npmCli: 'C:\\bundle\\npm-cli.js', npxCli: 'C:\\bundle\\npx-cli.js',
      }, 'win32')
      expect(paths.nodeGlobalBinDirectory).toBe(join(root, 'electron', 'node-global'))
      expect(paths.pythonUserBinDirectory).toBe(join(root, 'electron', 'python-user', 'Scripts'))
      expect(readFileSync(join(paths.shimDirectory, 'npm.cmd'), 'utf8')).toContain('"C:\\bundle\\node.exe" "C:\\bundle\\npm-cli.js"')
      expect(readFileSync(join(paths.shimDirectory, 'pip.cmd'), 'utf8')).toContain('"C:\\bundle\\python.exe" -m pip')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
