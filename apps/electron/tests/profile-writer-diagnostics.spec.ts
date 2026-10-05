/** Probe evidence records writer ownership without exporting profile content. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { readProfileWriterState } from '../scripts/profile-writer-diagnostics.mjs'

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
