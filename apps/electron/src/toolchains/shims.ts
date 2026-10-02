import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DesktopToolchains } from './domain.ts'

const PYTHON_RUNTIME_COMMANDS = ['python', 'python3'] as const
const PYTHON_PIP_COMMANDS = ['pip', 'pip3'] as const
const NODE_PACKAGE_COMMANDS = [['npm', 'npmCli'], ['npx', 'npxCli']] as const

function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function cmdValue(value: string): string {
  if (/["\r\n]/u.test(value)) throw new Error('desktop toolchains: unsafe Windows shim path')
  return value.replaceAll('%', '%%')
}
function cmd(value: string): string { return `"${cmdValue(value)}"` }

function writeShim(directory: string, name: string, body: string, windows: boolean): void {
  if (windows) {
    writeFileSync(join(directory, `${name}.cmd`), `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${body}\r\n`)
    return
  }
  const path = join(directory, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  chmodSync(path, 0o700)
}

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
  const windows = platform === 'win32'
  const nodeGlobalBinDirectory = windows ? nodeGlobal : join(nodeGlobal, 'bin')
  const pythonUserBinDirectory = join(pythonUserBase, windows ? 'Scripts' : 'bin')
  for (const directory of [
    shimDirectory, pythonUserBase, nodeGlobal, nodeGlobalBinDirectory, pythonUserBinDirectory,
  ]) mkdirSync(directory, { recursive: true })
  const python = toolchains.python
  const node = toolchains.node
  rmSync(shimDirectory, { recursive: true, force: true })
  mkdirSync(shimDirectory, { recursive: true })
  if (python !== undefined) {
    const pythonRuntime = windows
      ? `if not defined PYTHONUSERBASE set "PYTHONUSERBASE=${cmdValue(pythonUserBase)}"\r\nif /I "%~1"=="-m" if /I "%~2"=="pip" set "PIP_USER=1"\r\n${cmd(python.executable)} %*`
      : `if [ "\${PYTHONUSERBASE+x}" != x ]; then PYTHONUSERBASE=${shell(pythonUserBase)}; export PYTHONUSERBASE; fi\nif [ "$1" = -m ] && [ "$2" = pip ]; then PIP_USER=1; export PIP_USER; fi\nexec ${shell(python.executable)} "$@"`
    const pythonPip = windows
      ? `if not defined PYTHONUSERBASE set "PYTHONUSERBASE=${cmdValue(pythonUserBase)}"\r\nset "PIP_USER=1"\r\n${cmd(python.executable)} -m pip %*`
      : `if [ "\${PYTHONUSERBASE+x}" != x ]; then PYTHONUSERBASE=${shell(pythonUserBase)}; export PYTHONUSERBASE; fi\nPIP_USER=1 exec ${shell(python.executable)} -m pip "$@"`
    for (const name of PYTHON_RUNTIME_COMMANDS) writeShim(shimDirectory, name, pythonRuntime, windows)
    for (const name of PYTHON_PIP_COMMANDS) writeShim(shimDirectory, name, pythonPip, windows)
  }
  if (node !== undefined) {
    const nodePackage = (cli: string): string => windows
      ? `if not defined NPM_CONFIG_PREFIX set "NPM_CONFIG_PREFIX=${cmdValue(nodeGlobal)}"\r\n${cmd(node.executable)} ${cmd(cli)} %*`
      : `if [ "\${NPM_CONFIG_PREFIX+x}" != x ]; then NPM_CONFIG_PREFIX=${shell(nodeGlobal)}; export NPM_CONFIG_PREFIX; fi\nexec ${shell(node.executable)} ${shell(cli)} "$@"`
    for (const [name, key] of NODE_PACKAGE_COMMANDS) writeShim(shimDirectory, name, nodePackage(node[key]), windows)
  }
  return { shimDirectory, pythonUserBase, nodeGlobalBinDirectory, pythonUserBinDirectory }
}
