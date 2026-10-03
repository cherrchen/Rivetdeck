/** Real packaged Desktop smoke; --startup-only checks Core boot without advancing onboarding. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(root, 'apps/web/package.json'))
const { _electron } = require('playwright')
const executablePath = resolve(process.argv[2])
const scratch = await mkdtemp(join(tmpdir(), 'dsh-runtime-smoke-'))
const userData = join(scratch, 'userData')
const env = { ...process.env, DSH_HOME: join(scratch, 'harness'), DSH_TELEMETRY_DISABLED: '1' }
delete env.ELECTRON_RUN_AS_NODE
if (process.argv.includes('--offline')) {
  env.pnpm_config_registry = 'https://127.0.0.1:9'
  env.pnpm_config_fetch_retries = '0'
  env.pnpm_config_store_dir = join(scratch, 'empty-store')
}
let application
const events = []
async function launch() {
  application = await _electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], env, timeout: 120_000 })
  application.process().stderr.on('data', bytes => process.stderr.write(bytes))
  application.process().stdout.on('data', bytes => process.stdout.write(bytes))
  const page = await application.firstWindow({ timeout: 120_000 })
  page.on('pageerror', error => console.error('renderer error:', error))
  await page.waitForFunction(() => window.deepseekDesktop !== undefined)
  await page.getByRole('button', { name: /Settings|设置/, exact: true }).waitFor({ timeout: 120_000 })
  return page
}
async function close() {
  if (application === undefined) return
  await application.close()
  application = undefined
}
async function smoke() {
  let page = await launch()
  const resources = await application.evaluate(() => process.resourcesPath)
  const preferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences())
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.sandbox, true)
  for (const name of ['node', 'python']) await assert.rejects(stat(join(resources, 'toolchains', name)))
  if (process.platform === 'win32') {
    assert.ok((await stat(join(resources, 'core-runtime/node.exe'))).size > 0)
    await assert.rejects(stat(join(resources, 'core-runtime/node_modules')))
  }
  const dialog = page.getByRole('dialog', { name: /Optional Runtime Environments|可选运行环境/ })
  await dialog.waitFor({ timeout: 120_000 })
  assert.equal((await page.evaluate(() => window.deepseekDesktop.runtimes.getState())).node.phase, 'not-installed')
  assert.equal((await page.evaluate(() => window.deepseekDesktop.runtimes.getState())).python.phase, 'not-installed')
  events.push('Core Host and shell ready with zero managed runtimes; optional dialog visible')
  await page.screenshot({ path: join(scratch, 'setup.png') })
  if (process.argv.includes('--startup-only')) return
  await dialog.getByRole('button', { name: /Skip for now|暂时跳过/, exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal((await page.evaluate(() => window.deepseekDesktop.runtimes.getState())).onboardingCompleted, true)
  events.push('Skip persisted without installation')
  const preview = page.getByRole('dialog', { name: /Preview Notice|预览版说明/ })
  await preview.getByRole('button', { name: /Continue|继续/, exact: true }).click({ timeout: 30_000 })
  await preview.waitFor({ state: 'hidden', timeout: 180_000 })
  await close()
  page = await launch()
  assert.equal((await page.evaluate(() => window.deepseekDesktop.runtimes.getState())).onboardingCompleted, true)
  await page.getByRole('button', { name: /Close|关闭|Configure later|稍后配置/, exact: true }).click({ timeout: 60_000 })
  await page.getByRole('button', { name: /Settings|设置/, exact: true }).click()
  await page.getByText(/Network & Runtimes|网络与运行环境/, { exact: true }).first().click()
  await page.getByRole('heading', { name: /Network & Runtimes|网络与运行环境/, exact: true }).waitFor()
  assert.equal(await page.getByRole('dialog', { name: /Optional Runtime Environments|可选运行环境/ }).count(), 0)
  await page.screenshot({ path: join(scratch, 'settings.png') })
  events.push('Restart keeps Skip; Settings runtime section opens')
  if (process.argv.includes('--install')) {
    for (const name of ['node', 'python']) {
      const row = page.getByRole('article', { name: name === 'node' ? 'Node.js' : 'Python', exact: true })
      await row.getByRole('button', { name: /Download|下载/, exact: true }).click()
      const deadline = Date.now() + 600_000
      while (true) {
        const state = (await page.evaluate(() => window.deepseekDesktop.runtimes.getState()))[name]
        if (state.phase === 'failed') throw new Error(`runtime install failed: ${state.error}`)
        if (state.phase === 'installed') break
        if (Date.now() > deadline) throw new Error(`runtime install timed out: ${name}`)
        await page.waitForTimeout(250)
      }
      const state = (await page.evaluate(() => window.deepseekDesktop.runtimes.getState()))[name]
      const receipt = JSON.parse(await readFile(join(userData, 'managed-toolchains', name, 'active.json'), 'utf8'))
      assert.equal(receipt.pendingRemoval, false)
      assert.equal(state.restartRequired, true)
      const interpreter = join(state.location, process.platform === 'win32' ? `${name}.exe` : name === 'node' ? 'bin/node' : 'bin/python3')
      assert.ok((await stat(interpreter)).size > 0)
      execFileSync(interpreter, ['--version'], { env, windowsHide: true })
      if (name === 'node') {
        const npm = join(state.location, process.platform === 'win32' ? 'node_modules/npm/bin' : 'lib/node_modules/npm/bin')
        for (const cli of ['npm-cli.js', 'npx-cli.js']) execFileSync(interpreter, [join(npm, cli), '--version'], { env, windowsHide: true })
      } else execFileSync(interpreter, ['-m', 'pip', '--version'], { env, windowsHide: true })
      events.push(`${name}: installed through Settings and verified real interpreter`)
    }
    await page.screenshot({ path: join(scratch, 'installed.png') })
    await close()
    page = await launch()
    const installed = await page.evaluate(() => window.deepseekDesktop.runtimes.getState())
    assert.equal(installed.node.phase, 'installed'); assert.equal(installed.python.phase, 'installed')
    await page.getByRole('button', { name: /Close|关闭|Configure later|稍后配置/, exact: true }).click({ timeout: 60_000 })
    await page.getByRole('button', { name: /Settings|设置/, exact: true }).click()
    await page.getByText(/Network & Runtimes|网络与运行环境/, { exact: true }).first().click()
    await page.getByRole('article', { name: 'Node.js', exact: true }).getByRole('button', { name: /Remove|移除/, exact: true }).click()
    await page.getByRole('button', { name: /Confirm removal|确认移除/, exact: true }).click()
    assert.equal((await page.evaluate(() => window.deepseekDesktop.runtimes.getState())).node.phase, 'removing')
    await close()
    page = await launch()
    const removed = await page.evaluate(() => window.deepseekDesktop.runtimes.getState())
    assert.equal(removed.node.phase, 'not-installed'); assert.equal(removed.python.phase, 'installed')
    events.push('Deferred Node removal preserves Python and Core Host after restart')
  }
}
try {
  await smoke()
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, executablePath, scratch, events }, null, 2))
} catch (error) {
  const page = application?.windows()[0]
  if (page !== undefined && !page.isClosed()) {
    console.error('smoke failure UI:', await page.locator('body').innerText())
    await page.screenshot({ path: join(scratch, 'failure.png') })
  }
  console.error('smoke artifacts:', scratch)
  throw error
} finally {
  await close()
  if (!process.argv.includes('--keep')) await rm(scratch, { recursive: true, force: true })
}
