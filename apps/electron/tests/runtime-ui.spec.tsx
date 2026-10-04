// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeSettings, RuntimeSetup } from '../runtime/plugins/desktop-capabilities/src/client/features/runtime-settings/RuntimeSettings.tsx'
import { en, zh } from '../runtime/plugins/desktop-capabilities/src/client/features/runtime-settings/locales.ts'
import type { RuntimeCapability, RuntimeName, RuntimeSnapshot } from '../src/toolchains/domain.ts'

const containers: HTMLElement[] = []
afterEach(() => { for (const container of containers.splice(0)) container.remove() })

function capability(initial?: RuntimeSnapshot) {
  let state: RuntimeSnapshot = initial ?? {
    onboardingCompleted: false,
    node: { name: 'node', version: '24.17.0', phase: 'not-installed', restartRequired: false },
    python: { name: 'python', version: '3.14.7', phase: 'not-installed', restartRequired: false },
  }
  const listeners = new Set<(value: RuntimeSnapshot) => void>()
  const calls: string[] = []
  const installs: Promise<void>[] = []
  const emit = () => { for (const listener of listeners) listener(structuredClone(state)) }
  const control: {
    completeOnboarding: () => Promise<void>
    install: (name: RuntimeName) => Promise<void>
  } = {
    completeOnboarding: async () => { state = { ...state, onboardingCompleted: true }; emit() },
    install: async (name) => {
      calls.push(name)
      state = { ...state, [name]: { ...state[name], phase: 'downloading', received: 5, total: 10 } }
      emit()
    },
  }
  const runtimes: RuntimeCapability = {
    getState: async () => structuredClone(state),
    subscribe: (listener) => { listeners.add(listener); listener(structuredClone(state)); return () => { listeners.delete(listener) } },
    completeOnboarding: () => control.completeOnboarding(),
    install: (name) => {
      const pending = control.install(name)
      installs.push(pending)
      return pending
    },
    cancel: async (name) => { calls.push(`cancel:${name}`) },
    remove: async (name) => { calls.push(`remove:${name}`) },
  }
  return {
    runtimes, calls, installs, control, emit: (next: RuntimeSnapshot) => { state = next; emit() },
    state: () => structuredClone(state),
  }
}

const t = (key: keyof typeof en) => en[key]
function button(text: string) {
  const result = [...document.querySelectorAll('button')].find(item => item.textContent === text)
  if (result === undefined) throw new Error(`button missing: ${text}`)
  return result
}
async function click(element: HTMLElement) { await act(async () => { element.click() }) }
function dialog() { return document.querySelector('[role="dialog"]') }

function mount(fake: ReturnType<typeof capability>, translate = t) {
  const container = document.createElement('div')
  document.body.append(container)
  containers.push(container)
  const root = createRoot(container)
  let setup = true
  let completions = 0
  const render = () => {
    root.render(<>
      {setup && <RuntimeSetup
        complete={() => { completions += 1; setup = false; render() }}
        runtimes={fake.runtimes} restart={async () => {}} t={translate} />}
      <RuntimeSettings runtimes={fake.runtimes} restart={async () => {}} t={translate} />
    </>)
  }
  return {
    render, completions: () => completions,
    unmount: () => act(async () => { root.unmount() }),
  }
}

describe('optional runtime views', () => {
  it('persists Skip, advances the step, and downloads nothing', async () => {
    const fake = capability()
    const view = mount(fake)
    try {
      await act(async () => { view.render() })
      expect(dialog()).not.toBeNull()
      expect(fake.calls).toEqual([])
      await click(button(en.skip))
      expect(fake.state().onboardingCompleted).toBe(true)
      expect(view.completions()).toBe(1)
      expect(dialog()).toBeNull()
      expect(fake.calls).toEqual([])
      expect(document.body.textContent).toContain(en.title)
    } finally { await view.unmount() }
  })

  for (const selection of [[0], [1], [0, 1]] as const) {
    it(`starts only checked choices ${selection.join(',')} and leaves the dialog before download finishes`, async () => {
      const fake = capability()
      let release = () => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      fake.control.install = async (name) => {
        fake.calls.push(name)
        fake.emit({ ...fake.state(), [name]: { ...fake.state()[name], phase: 'downloading', received: 5, total: 10 } })
        await gate
      }
      const view = mount(fake)
      try {
        await act(async () => { view.render() })
        const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
        for (const index of selection) await click(choices[index]!)
        expect(fake.calls).toEqual([])
        await click(button(en.selected))
        expect(fake.calls).toEqual(selection.map(index => index === 0 ? 'node' : 'python'))
        expect(fake.state().onboardingCompleted).toBe(true)
        expect(view.completions()).toBe(1)
        expect(dialog()).toBeNull()
        expect(document.querySelectorAll('progress')).toHaveLength(selection.length)
        expect(document.body.textContent).toContain(en.title)
        let finished = false
        void Promise.all(fake.installs).then(() => { finished = true })
        await Promise.resolve()
        expect(finished).toBe(false)
      } finally {
        release()
        await view.unmount()
      }
    })
  }

  it('advances a profile that already finished setup', async () => {
    const fake = capability()
    fake.emit({ ...fake.state(), onboardingCompleted: true })
    const view = mount(fake)
    try {
      await act(async () => { view.render() })
      expect(dialog()).toBeNull()
      expect(view.completions()).toBe(1)
      expect(fake.calls).toEqual([])
    } finally { await view.unmount() }
  })

  it.each([['English', en], ['Chinese', zh]] as const)('omits the close control and ignores the mask and Escape in %s', async (_locale, messages) => {
    const fake = capability()
    const view = mount(fake, key => messages[key])
    try {
      await act(async () => { view.render() })
      expect(dialog()?.getAttribute('aria-label')).toBe(messages.setup)
      expect(dialog()?.querySelector('h2')?.textContent).toBe(messages.setup)
      expect(document.querySelector(`[role="dialog"] button[aria-label="${messages.close}"]`)).toBeNull()
      expect(document.activeElement?.getAttribute('role')).toBe('switch')
      const mask = document.querySelector<HTMLElement>('[role="presentation"] > [aria-hidden="true"]')
      expect(mask).not.toBeNull()
      await click(mask!)
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      expect(fake.state().onboardingCompleted).toBe(false)
      expect(view.completions()).toBe(0)
      expect(dialog()).not.toBeNull()
      expect(fake.calls).toEqual([])
    } finally { await view.unmount() }
  })

  it('keeps the dialog when persistence fails and accepts a later choice', async () => {
    const fake = capability()
    let fail = true
    let writes = 0
    fake.control.completeOnboarding = async () => {
      writes += 1
      if (fail) throw new Error('persist failed')
      fake.emit({ ...fake.state(), onboardingCompleted: true })
    }
    const view = mount(fake)
    try {
      await act(async () => { view.render() })
      await click(document.querySelectorAll<HTMLButtonElement>('[role="switch"]')[0]!)
      await click(button(en.selected))
      expect(dialog()).not.toBeNull()
      expect(document.body.textContent).toContain(en.operationError)
      expect(fake.calls).toEqual([])
      expect(view.completions()).toBe(0)
      expect(fake.state().onboardingCompleted).toBe(false)
      expect(writes).toBe(1)
      fail = false
      await click(button(en.selected))
      expect(writes).toBe(2)
      expect(view.completions()).toBe(1)
      expect(fake.calls).toEqual(['node'])
      expect(dialog()).toBeNull()
      expect(fake.state().onboardingCompleted).toBe(true)
    } finally { await view.unmount() }
  })

  it('settles one click while persistence is still pending', async () => {
    const fake = capability()
    let writes = 0
    let release = () => {}
    fake.control.completeOnboarding = () => new Promise<void>((resolve) => {
      writes += 1
      release = () => {
        fake.emit({ ...fake.state(), onboardingCompleted: true })
        resolve()
      }
    })
    const view = mount(fake)
    try {
      await act(async () => { view.render() })
      await click(document.querySelectorAll<HTMLButtonElement>('[role="switch"]')[0]!)
      await act(async () => {
        button(en.selected).click()
        button(en.selected).click()
        button(en.skip).click()
      })
      expect(writes).toBe(1)
      expect(view.completions()).toBe(0)
      expect(fake.calls).toEqual([])
      expect(button(en.skip).disabled).toBe(true)
      expect(button(en.selected).disabled).toBe(true)
      expect(dialog()).not.toBeNull()
      await act(async () => { release() })
      expect(writes).toBe(1)
      expect(view.completions()).toBe(1)
      expect(fake.calls).toEqual(['node'])
      expect(dialog()).toBeNull()
    } finally { await view.unmount() }
  })

  it('confirms removal from Settings', async () => {
    const fake = capability()
    fake.emit({
      ...fake.state(), onboardingCompleted: true,
      node: { ...fake.state().node, phase: 'installed', installedVersion: '24.17.0', location: '/managed/node' },
    })
    const container = document.createElement('div')
    document.body.append(container)
    containers.push(container)
    const root = createRoot(container)
    try {
      await act(async () => { root.render(<RuntimeSettings runtimes={fake.runtimes} restart={async () => {}} t={t} />) })
      expect(document.body.textContent).toContain('/managed/node')
      await click(button(en.remove))
      expect(fake.calls).not.toContain('remove:node')
      await click(button(en.confirmRemove))
      expect(fake.calls).toContain('remove:node')
    } finally { await act(async () => { root.unmount() }) }
  })

  it('shows an interruption alert beside an available runtime', async () => {
    const fake = capability({
      onboardingCompleted: true,
      node: { name: 'node', version: '24.17.0', phase: 'installed', installedVersion: '24.17.0', location: '/managed/node', restartRequired: false, error: 'interrupted' },
      python: { name: 'python', version: '3.14.7', phase: 'update-available', installedVersion: '3.14.0', location: '/managed/python', restartRequired: false, error: 'interrupted' },
    })
    const container = document.createElement('div')
    document.body.append(container)
    containers.push(container)
    const root = createRoot(container)
    try {
      await act(async () => { root.render(<RuntimeSettings runtimes={fake.runtimes} restart={async () => {}} t={t} />) })
      expect(document.body.textContent).toContain(en.installed)
      expect(document.body.textContent).toContain(en['update-available'])
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(2)
      expect(document.body.textContent).toContain(en.interruptedError)
      const labels = [...document.querySelectorAll('button')].map(item => item.textContent)
      expect(labels).toContain(en.reinstall)
      expect(labels).toContain(en.update)
      expect(labels).not.toContain(en.retry)
    } finally { await act(async () => { root.unmount() }) }
  })
})
