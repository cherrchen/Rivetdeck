/** Real plugin lifecycle through the packaged Core executor and bundled pnpm. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const executable = resolve(process.argv[2])
const appPath = resolve(process.argv[3])
const scratch = await mkdtemp(join(tmpdir(), 'dsh-core-plugins-'))
const moduleUrl = relative => pathToFileURL(join(appPath, relative)).href
const code = `
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { preparePluginPackageManager } from ${JSON.stringify(moduleUrl('lib/plugin-package-manager.js'))}
import { runPluginCommand } from ${JSON.stringify(moduleUrl('node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js'))}
const appPath = ${JSON.stringify(appPath)}
const home = ${JSON.stringify(scratch)}
const core = ${JSON.stringify(executable)}
const pnpm = join(appPath, 'node_modules/pnpm/bin/pnpm.cjs')
const manager = preparePluginPackageManager(home, core, pnpm)
const env = { ELECTRON_RUN_AS_NODE: process.platform === 'win32' ? '' : '1', PATH: manager.envPath }
const reported = execFileSync(process.platform === 'win32' ? core : join(manager.binDirectory, 'node'), ['-p', 'process.execPath'], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true }).trim()
assert.equal(reported, core)
const manifest = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8'))
const name = '@dsh-electron/dsh-theme-studio'
for (const args of [['add', name + '@' + manifest.dependencies[name]], ['remove', name], ['add', name + '@' + manifest.dependencies[name]]]) {
  const result = await runPluginCommand({ profile: 'web', home, cwd: appPath, installAnchor: join(appPath, 'node_modules/@deepseek-ai/dsh/package.json') }, args, { command: core, args: [pnpm], env, execution: 'service', outputBytes: 8192 })
  assert.equal(result.exitCode, 0, result.output)
  const selected = JSON.parse(readFileSync(join(home, 'profiles/web/package.json'), 'utf8'))
  assert.equal(Object.hasOwn(selected.dependencies ?? {}, name), args[0] === 'add')
}
assert.equal(existsSync(join(home, 'managed-toolchains')), false)
console.log('Core-only plugin add/remove/reinstall and profile reconciliation passed; bundled pnpm ' + JSON.parse(readFileSync(join(appPath, 'node_modules/pnpm/package.json'), 'utf8')).version)
`
try {
  const script = join(scratch, 'probe.mjs')
  await writeFile(script, code)
  execFileSync(executable, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: process.platform === 'win32' ? '' : '1', DSH_HOME: scratch }, stdio: 'inherit', windowsHide: true, timeout: 180_000 })
} finally { await rm(scratch, { recursive: true, force: true }) }
