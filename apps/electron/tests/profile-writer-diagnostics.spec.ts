/** Probe evidence records writer ownership without exporting profile content. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { createProfileSetupObserver, readProfileWriterState, waitForProfileSetup } from '../scripts/profile-writer-diagnostics.mjs'
import { createSmokeScratch } from '../scripts/smoke-scratch.mjs'

it.each([true, false])('waits for setup settlement and writer release with ecosystem installation success=%s', async (success) => {
  const home = await mkdtemp(join(tmpdir(), 'profile-setup-readiness-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  const profile = join(home, 'profiles', 'web')
  await mkdir(join(profile, '.plugin-manager'), { recursive: true })
  await mkdir(join(home, 'electron'))
  const setup = createProfileSetupObserver()
  const observed: Awaited<ReturnType<typeof readProfileWriterState>>[] = []
  await waitForProfileSetup(home, setup.isSettled, async (state) => {
    observed.push(state)
    switch (observed.length) {
      case 1:
        if (success) await writeFile(join(home, 'electron', 'ecosystem-preinstalled'), 'complete\n')
        await writeFile(join(profile, 'package.json.lock'), '123\n')
        await writeFile(join(profile, '.plugin-manager', 'run.json'), '{"pid":456}')
        break
      case 2:
        setup.write('desktop ecosystem profile setup ')
        setup.write('settled\n')
        break
      case 3:
        await rm(join(profile, 'package.json.lock'))
        break
      case 4:
        await rm(join(profile, '.plugin-manager', 'run.json'))
        break
    }
  })
  expect(observed).toEqual([
    { holderPid: null, packagePid: null, ecosystemCompleted: false },
    { holderPid: 123, packagePid: 456, ecosystemCompleted: success },
    { holderPid: 123, packagePid: 456, ecosystemCompleted: success },
    { holderPid: null, packagePid: 456, ecosystemCompleted: success },
    { holderPid: null, packagePid: null, ecosystemCompleted: success },
  ])
})

it('keeps setup settlement local to each launch and ignores unrelated output', () => {
  const first = createProfileSetupObserver()
  first.write('desktop ecosystem profile setup failed; bundled plugins remain available\n')
  expect(first.isSettled()).toBe(false)
  first.write('desktop ecosystem profile setup settled\n')
  expect(first.isSettled()).toBe(true)
  expect(createProfileSetupObserver().isSettled()).toBe(false)
})

it('allocates distinct Store probe directories in the build workspace outside AppData', async () => {
  const first = await createSmokeScratch('store-probe-', true)
  onTestFinished(async () => { await rm(first, { recursive: true, force: true }) })
  const second = await createSmokeScratch('store-probe-', true)
  onTestFinished(async () => { await rm(second, { recursive: true, force: true }) })
  expect(first).not.toBe(second)
  expect(first.replaceAll('\\', '/')).toContain('/apps/electron/.electron-build/store-probe-')
  expect(first.replaceAll('\\', '/').toLowerCase()).not.toContain('/appdata/')
  await writeFile(join(first, 'owner'), 'first\n', { flag: 'wx' })
  await writeFile(join(second, 'owner'), 'second\n', { flag: 'wx' })
})

it('observes writer acquisition and release independently of ecosystem completion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'profile-writer-evidence-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  expect(await readProfileWriterState(home)).toEqual({ holderPid: null, packagePid: null, ecosystemCompleted: false })
  const profile = join(home, 'profiles', 'web')
  await mkdir(join(profile, '.plugin-manager'), { recursive: true })
  await writeFile(join(profile, 'package.json.lock'), '123\n')
  await writeFile(join(profile, '.plugin-manager', 'run.json'), JSON.stringify({ pid: 456, grouped: false, args: ['private-input'] }))
  expect(await readProfileWriterState(home)).toEqual({ holderPid: 123, packagePid: 456, ecosystemCompleted: false })
  await rm(join(profile, 'package.json.lock'))
  expect(await readProfileWriterState(home)).toEqual({ holderPid: null, packagePid: 456, ecosystemCompleted: false })
  await rm(join(profile, '.plugin-manager', 'run.json'))
  await mkdir(join(home, 'electron'))
  await writeFile(join(home, 'electron', 'ecosystem-preinstalled'), 'complete\n')
  expect(await readProfileWriterState(home)).toEqual({ holderPid: null, packagePid: null, ecosystemCompleted: true })
})

it('rejects malformed writer records instead of inventing an owner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'profile-writer-invalid-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  const profile = join(home, 'profiles', 'web')
  await mkdir(join(profile, '.plugin-manager'), { recursive: true })
  for (const lock of ['not-a-pid\n', '0\n', '9007199254740992\n']) {
    await writeFile(join(profile, 'package.json.lock'), lock)
    await expect(readProfileWriterState(home)).rejects.toThrow(/invalid lock record|positive PID/)
  }
  await rm(join(profile, 'package.json.lock'))
  await writeFile(join(profile, '.plugin-manager', 'run.json'), '{"pid":-1}')
  await expect(readProfileWriterState(home)).rejects.toThrow('positive PID')
})
