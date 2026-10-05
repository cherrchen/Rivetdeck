import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareToolchainShims } from '../src/toolchains/shims.ts'

const posixShimNames = ['npm', 'npx', 'pip', 'pip3', 'python', 'python3']
const windowsShimNames = posixShimNames.map(name => `${name}.cmd`)

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
      const paths = prepareToolchainShims({ userData: join(root, 'desktop'), harnessHome: root }, {
        node: { executable: node, version: '24.17.0', binDirectory: root, npmCli: join(root, 'npm-cli.js'), npxCli: join(root, 'npx-cli.js') },
        python: { executable: python, version: '3.14.7', binDirectory: root },
      }, 'darwin')
      expect(readdirSync(paths.shimDirectory).sort()).toEqual(posixShimNames)
      expect(paths.shimDirectory).toBe(join(root, 'desktop', 'electron', 'toolchains', 'bin'))
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
      expect(readFileSync(join(paths.shimDirectory, 'python3'), 'utf8'))
        .toBe(readFileSync(join(paths.shimDirectory, 'python'), 'utf8'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes Windows fallback commands against their exact runtimes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-toolchain-win-shims-'))
    try {
      const paths = prepareToolchainShims({ userData: join(root, 'desktop'), harnessHome: root }, {
        node: { executable: 'C:\\bundle\\node.exe', version: '24.17.0', binDirectory: root, npmCli: 'C:\\bundle\\npm-cli.js', npxCli: 'C:\\bundle\\npx-cli.js' },
        python: { executable: 'C:\\bundle\\python.exe', version: '3.14.7', binDirectory: root },
      }, 'win32')
      expect(readdirSync(paths.shimDirectory).sort()).toEqual(windowsShimNames)
      expect(paths.nodeGlobalBinDirectory).toBe(join(root, 'electron', 'node-global'))
      expect(paths.pythonUserBinDirectory).toBe(join(root, 'electron', 'python-user', 'Scripts'))
      expect(readFileSync(join(paths.shimDirectory, 'npm.cmd'), 'utf8')).toContain('"C:\\bundle\\node.exe" "C:\\bundle\\npm-cli.js"')
      const pip = readFileSync(join(paths.shimDirectory, 'pip.cmd'), 'utf8')
      expect(pip).toContain(`set "PYTHONUSERBASE=${paths.pythonUserBase}"`)
      expect(pip).toContain('\r\nset "PIP_USER=1"\r\n"C:\\bundle\\python.exe" -m pip %*')
      const python = readFileSync(join(paths.shimDirectory, 'python.cmd'), 'utf8')
      expect(python).toContain(`set "PYTHONUSERBASE=${paths.pythonUserBase}"`)
      expect(python).toContain('if /I "%~1"=="-m" if /I "%~2"=="pip" set "PIP_USER=1"')
      expect(python).toContain('"C:\\bundle\\python.exe" %*')
      expect(python).not.toContain('\r\nset "PIP_USER=1"\r\n')
      expect(readFileSync(join(paths.shimDirectory, 'python3.cmd'), 'utf8')).toBe(python)
      expect(readFileSync(join(paths.shimDirectory, 'pip3.cmd'), 'utf8')).toBe(pip)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('optional shim lifecycle', () => {
  it.each(['linux', 'win32'] as const)('preserves existing Harness packages with separate Desktop storage on %s', async (platform) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-upgrade-'))
    try {
      const storage = { userData: join(root, 'desktop'), harnessHome: join(root, 'custom harness home') }
      const pythonUserBase = join(storage.harnessHome, 'electron', 'python-user')
      const nodeGlobal = join(storage.harnessHome, 'electron', 'node-global')
      mkdirSync(pythonUserBase, { recursive: true })
      mkdirSync(nodeGlobal, { recursive: true })
      writeFileSync(join(pythonUserBase, 'installed-package'), 'python package')
      writeFileSync(join(nodeGlobal, 'installed-package'), 'npm package')
      const paths = prepareToolchainShims(storage, {}, platform)
      expect(paths.pythonUserBase).toBe(pythonUserBase)
      expect(paths.nodeGlobalBinDirectory).toBe(platform === 'win32' ? nodeGlobal : join(nodeGlobal, 'bin'))
      expect(readFileSync(join(pythonUserBase, 'installed-package'), 'utf8')).toBe('python package')
      expect(readFileSync(join(nodeGlobal, 'installed-package'), 'utf8')).toBe('npm package')
      expect(readdirSync(paths.shimDirectory)).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('cleans obsolete managed commands without creating Core commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-optional-shims-'))
    try {
      const paths = prepareToolchainShims({ userData: join(root, 'desktop'), harnessHome: root }, { python: { executable: '/managed/python', version: '3.14.7', binDirectory: '/managed' } }, 'linux')
      expect(readdirSync(paths.shimDirectory).sort()).toEqual(['pip', 'pip3', 'python', 'python3'])
      prepareToolchainShims({ userData: join(root, 'desktop'), harnessHome: root }, {}, 'linux')
      expect(readdirSync(paths.shimDirectory)).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
