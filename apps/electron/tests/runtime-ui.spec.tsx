// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeSettings, RuntimeSetup } from '../runtime/plugins/desktop-capabilities/src/client/features/runtime-settings/RuntimeSettings.tsx'
import { en } from '../runtime/plugins/desktop-capabilities/src/client/features/runtime-settings/locales.ts'
import type { RuntimeCapability, RuntimeSnapshot } from '../src/toolchains/domain.ts'

const containers: HTMLElement[] = []
afterEach(() => { for (const container of containers.splice(0)) container.remove() })
function capability() {
  let state: RuntimeSnapshot = { onboardingCompleted: false, node: { name: 'node', version: '24.17.0', phase: 'not-installed', restartRequired: false }, python: { name: 'python', version: '3.14.7', phase: 'not-installed', restartRequired: false } }
  const listeners = new Set<(value: RuntimeSnapshot) => void>()
  const calls: string[] = []
  const emit = () => { for (const listener of listeners) listener(structuredClone(state)) }
  const runtimes: RuntimeCapability = {
    getState: async () => structuredClone(state),
    subscribe: (listener) => { listeners.add(listener); listener(state); return () => { listeners.delete(listener) } },
    completeOnboarding: async () => { state.onboardingCompleted = true; emit() },
    install: async (name) => { calls.push(name); state[name] = { ...state[name], phase: 'downloading', received: 5, total: 10 }; emit() },
    cancel: async (name) => { calls.push(`cancel:${name}`) },
    remove: async (name) => { calls.push(`remove:${name}`) },
  }
  return { runtimes, calls, emit: (next: RuntimeSnapshot) => { state = next; emit() }, state: () => structuredClone(state) }
}
const t = (key: keyof typeof en) => en[key]
function button(text: string) { const result = [...document.querySelectorAll('button')].find(button => button.textContent === text); if (result === undefined) throw new Error(`button missing: ${text}`); return result }
async function click(element: HTMLElement) { await act(async () => { element.click() }) }

describe('optional runtime views', () => {
  it('shows once and Skip persists without any download', async () => {
    const fake = capability()
    const container = document.createElement('div'); document.body.append(container); containers.push(container)
    const root = createRoot(container)
    try {
      await act(async () => { root.render(<RuntimeSetup complete={() => {}} runtimes={fake.runtimes} restart={async () => {}} t={t} />) })
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
      expect(fake.calls).toEqual([])
      await click(button(en.skip))
      expect(fake.state().onboardingCompleted).toBe(true)
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      await act(async () => { root.render(null) })
      await act(async () => { root.render(<RuntimeSetup complete={() => {}} runtimes={fake.runtimes} restart={async () => {}} t={t} />) })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally { await act(async () =>{  root.unmount() }) }
  })
  for (const selection of [[0], [1], [0, 1]]) {
    it(`installs only checked choices ${selection.join(',')} and shares Settings progress`, async () => {
      const fake = capability()
      const container = document.createElement('div'); document.body.append(container); containers.push(container)
      const root = createRoot(container)
      try {
        await act(async () => { root.render(<>
          <RuntimeSetup complete={() => {}} runtimes={fake.runtimes} restart={async () => {}} t={t} />
          <RuntimeSettings runtimes={fake.runtimes} restart={async () => {}} t={t} />
        </>) })
        const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
        for (const index of selection) await click(choices[index]!)
        expect(fake.calls).toEqual([])
        await click(button(en.selected))
        expect(fake.calls).toEqual(selection.map(index => index === 0 ? 'node' : 'python'))
        expect(document.querySelectorAll('progress')).toHaveLength(selection.length * 2)
        const next = fake.state()
        next.node = { ...next.node, phase: 'installed', location: '/managed/node', restartRequired: true }
        next.python = { ...next.python, phase: 'failed', error: 'download' }
        await act(async () => { fake.emit(next) })
        expect(document.body.textContent).toContain(en.downloadError)
        expect(document.body.textContent).toContain('/managed/node')
        await click(button(en.skip))
        await click(button(en.remove))
        expect(fake.calls).not.toContain('remove:node')
        await click(button(en.confirmRemove))
        expect(fake.calls).toContain('remove:node')
      } finally { await act(async () =>{  root.unmount() }) }
    })
  }
})
