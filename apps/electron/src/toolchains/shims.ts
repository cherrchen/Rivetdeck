import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DesktopToolchains } from './domain.ts'

function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function cmdValue(value: string): string {
  if (/["\r\n]/u.test(value)) throw new Error('desktop toolchains: unsafe Windows shim path')
  return value.replaceAll('%', '%%')
}
function cmd(value: string): string { return `"${cmdValue(value)}"` }

/** Create user-writable fallback commands that invoke exact application assets. */
export function prepareToolchainShims(harnessHome: string, toolchains: DesktopToolchains, platform: NodeJS.Platform): {
  shimDirectory: string
  pythonUserBase: string
  nodeGlobalBinDirectory: string
  pythonUserBinDirectory: string
} {
  const root = join(harnessHome, 'electron')
  const shimDirectory = join(root, 'toolchains', 'bin')
  const pythonUserBase = join(root, 'python-user')
  const nodeGlobal = join(root, 'node-global')
  const nodeGlobalBinDirectory = platform === 'win32' ? nodeGlobal : join(nodeGlobal, 'bin')
  const pythonUserBinDirectory = join(pythonUserBase, platform === 'win32' ? 'Scripts' : 'bin')
  for (const directory of [
    shimDirectory, pythonUserBase, nodeGlobal, nodeGlobalBinDirectory, pythonUserBinDirectory,
  ]) mkdirSync(directory, { recursive: true })
  if (platform === 'win32') {
    for (const [name, cli] of [['npm', toolchains.npmCli], ['npx', toolchains.npxCli]] as const) {
      writeFileSync(join(shimDirectory, `${name}.cmd`), `@echo off\r\nsetlocal DisableDelayedExpansion\r\nif not defined NPM_CONFIG_PREFIX set "NPM_CONFIG_PREFIX=${cmdValue(nodeGlobal)}"\r\n${cmd(toolchains.node.executable)} ${cmd(cli)} %*\r\n`)
    }
    for (const name of ['pip', 'pip3']) {
      writeFileSync(join(shimDirectory, `${name}.cmd`), `@echo off\r\nsetlocal DisableDelayedExpansion\r\nif not defined PYTHONUSERBASE set "PYTHONUSERBASE=${cmdValue(pythonUserBase)}"\r\nset "PIP_USER=1"\r\n${cmd(toolchains.python.executable)} -m pip %*\r\n`)
    }
  } else {
    const pythonBase = `if [ "\${PYTHONUSERBASE+x}" != x ]; then PYTHONUSERBASE=${shell(pythonUserBase)}; export PYTHONUSERBASE; fi\n`
    const pythonPip = 'if [ "$1" = -m ] && [ "$2" = pip ]; then PIP_USER=1; export PIP_USER; fi\n'
    const npmPrefix = `if [ "\${NPM_CONFIG_PREFIX+x}" != x ]; then NPM_CONFIG_PREFIX=${shell(nodeGlobal)}; export NPM_CONFIG_PREFIX; fi\n`
    const scripts = {
      python: `${pythonBase}${pythonPip}exec ${shell(toolchains.python.executable)} "$@"`,
      python3: `${pythonBase}${pythonPip}exec ${shell(toolchains.python.executable)} "$@"`,
      pip: `${pythonBase}PIP_USER=1 exec ${shell(toolchains.python.executable)} -m pip "$@"`,
      pip3: `${pythonBase}PIP_USER=1 exec ${shell(toolchains.python.executable)} -m pip "$@"`,
      npm: `${npmPrefix}exec ${shell(toolchains.node.executable)} ${shell(toolchains.npmCli)} "$@"`,
      npx: `${npmPrefix}exec ${shell(toolchains.node.executable)} ${shell(toolchains.npxCli)} "$@"`,
    }
    for (const [name, body] of Object.entries(scripts)) {
      const path = join(shimDirectory, name)
      writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
      chmodSync(path, 0o700)
    }
  }
  return { shimDirectory, pythonUserBase, nodeGlobalBinDirectory, pythonUserBinDirectory }
}
