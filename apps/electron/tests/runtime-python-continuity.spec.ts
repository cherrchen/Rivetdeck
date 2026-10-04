import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILD_ROOT } from '../scripts/toolchains/common.mjs'
import { loadManifest } from '../scripts/toolchains/manifest.mjs'
import { RuntimeManager } from '../src/toolchains/manager.ts'
import { prepareToolchainShims } from '../src/toolchains/shims.ts'

// The toolchain CI matrix prepares the pinned archive before enabling this offline regression.
describe.runIf(process.env.DSH_ELECTRON_RUNTIME_ARCHIVE_SMOKE === '1')('User package command continuity', () => {
  it('executes npm and Python package commands and a project venv after repeated reinstall and restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh python continuity-'))
    const lock = loadManifest()
    const target = `${process.platform}-${process.arch}` as keyof typeof lock.python.targets
    const entry = lock.python.targets[target]
    const managers: RuntimeManager[] = []
    try {
      const bytes = await readFile(join(BUILD_ROOT, 'downloads', `${entry.sha256}-${basename(new URL(entry.url).pathname)}`))
      const nodeEntry = lock.node.targets[target]
      const nodeBytes = await readFile(join(BUILD_ROOT, 'downloads', `${nodeEntry.sha256}-${basename(new URL(nodeEntry.url).pathname)}`))
      const options = { userData: join(root, 'desktop'), fetch: async (url: string) => {
        expect([entry.url, nodeEntry.url]).toContain(url)
        return new Response(url === entry.url ? bytes : nodeBytes)
      } }
      const start = async () => {
        const manager = new RuntimeManager(options)
        managers.push(manager)
        const toolchains = await manager.prepare()
        const paths = prepareToolchainShims({ userData: options.userData, harnessHome: join(root, 'harness') }, toolchains, process.platform)
        return { manager, toolchains, paths }
      }
      const installing = await start()
      await Promise.all([installing.manager.install('node'), installing.manager.install('python')])
      expect(installing.manager.state().python.phase).toBe('installed')
      await installing.manager.shutdown()
      const first = await start()
      const python = first.toolchains.python!.executable
      const env: NodeJS.ProcessEnv = {
        PATH: [process.env.PATH, first.paths.shimDirectory].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
        SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root,
        PYTHONUSERBASE: first.paths.pythonUserBase,
        PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        NPM_CONFIG_CACHE: join(root, 'npm-cache'),
        NPM_CONFIG_USERCONFIG: join(root, 'npm-user-config'),
        NPM_CONFIG_GLOBALCONFIG: join(root, 'npm-global-config'),
      }
      const run = (executable: string, args: string[]) => {
        // cmd.exe owns the quotes around batch paths; Node must not escape them again.
        const result = executable.endsWith('.cmd')
          ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${executable}" ${args.map(arg => `"${arg}"`).join(' ')}"`], {
            env, encoding: 'utf8', timeout: 60_000, windowsVerbatimArguments: true,
          })
          : spawnSync(executable, args, { env, encoding: 'utf8', timeout: 60_000 })
        expect(result.error, result.stderr).toBeUndefined()
        expect(result.signal, result.stderr).toBeNull()
        expect(result.status, result.stderr).toBe(0)
        return result.stdout.trim()
      }
      const wheel = join(root, 'dsh_continuity-1.0-py3-none-any.whl')
      run(python, ['-c', `import zipfile, sys
files = {
 'dsh_continuity.py': 'import sys\\ndef main():\\n    print("console-ok|" + sys.executable)\\n',
 'dsh_continuity-1.0.dist-info/METADATA': 'Metadata-Version: 2.1\\nName: dsh-continuity\\nVersion: 1.0\\n',
 'dsh_continuity-1.0.dist-info/WHEEL': 'Wheel-Version: 1.0\\nGenerator: dsh\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',
 'dsh_continuity-1.0.dist-info/entry_points.txt': '[console_scripts]\\ndsh-continuity = dsh_continuity:main\\n',
 'dsh_continuity-1.0.dist-info/RECORD': ''
}
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
 for name, content in files.items(): archive.writestr(name, content)
`, wheel])
      const pip = join(first.paths.shimDirectory, process.platform === 'win32' ? 'pip.cmd' : 'pip')
      run(pip, ['install', '--no-index', '--no-warn-script-location', wheel])
      const npmPackage = join(root, 'npm-package')
      await mkdir(npmPackage)
      await writeFile(join(npmPackage, 'package.json'), JSON.stringify({ name: 'dsh-continuity', version: '1.0.0', bin: { 'dsh-npm-continuity': 'cli.js' } }))
      await writeFile(join(npmPackage, 'cli.js'), '#!/usr/bin/env node\nconsole.log("npm-ok")\n')
      const npm = join(first.paths.shimDirectory, process.platform === 'win32' ? 'npm.cmd' : 'npm')
      run(npm, ['install', '--global', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', npmPackage])
      const npmCommand = join(first.paths.nodeGlobalBinDirectory, process.platform === 'win32' ? 'dsh-npm-continuity.cmd' : 'dsh-npm-continuity')
      expect(run(npmCommand, [])).toBe('npm-ok')
      const pythonScripts = run(python, ['-c', 'import sysconfig; print(sysconfig.get_path("scripts", sysconfig.get_preferred_scheme("user")))'])
      const command = join(pythonScripts, process.platform === 'win32' ? 'dsh-continuity.exe' : 'dsh-continuity')
      expect(run(command, [])).toBe(`console-ok|${python}`)
      const venv = join(root, 'project', '.venv')
      run(python, ['-m', 'venv', '--without-pip', venv])
      const venvPython = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      const base = run(venvPython, ['-c', 'import sys; print(sys.base_prefix)'])
      let active = first
      for (let count = 0; count < 2; count++) {
        await Promise.all([active.manager.install('node'), active.manager.install('python')])
        expect(active.manager.state().python.phase).toBe('installed')
        await active.manager.shutdown()
        active = await start()
        expect(active.manager.state().python.phase).toBe('installed')
        expect(active.toolchains.python!.executable).not.toBe(python)
        expect(active.paths.pythonUserBase).toBe(first.paths.pythonUserBase)
        expect(run(command, [])).toBe(`console-ok|${python}`)
        expect(run(npmCommand, [])).toBe('npm-ok')
        expect(run(venvPython, ['-c', 'import sys; print(sys.base_prefix)'])).toBe(base)
        expect(run(active.toolchains.python!.executable, ['-c', 'import dsh_continuity; dsh_continuity.main()'])).toBe(`console-ok|${active.toolchains.python!.executable}`)
      }
      // Reinstalling the package is also the recovery operation for legacy bundled-interpreter entry points.
      run(pip, ['install', '--no-index', '--user', '--force-reinstall', '--no-warn-script-location', wheel])
      expect(run(command, [])).toBe(`console-ok|${active.toolchains.python!.executable}`)
    } finally {
      await Promise.all(managers.map(manager => manager.shutdown()))
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
