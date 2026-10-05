import type { CallbackResponse, OnBeforeRequestListenerDetails, WebRequestFilter } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeFetch, type RuntimeDownloadSession } from '../src/toolchains/download.ts'

describe('policy-owned Chromium runtime transport', () => {
  it('uses the configured Session and prevents HTTP redirect requests', async () => {
    type Listener = (details: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void) => void
    const listeners: Listener[] = []
    const fetch = vi.fn<RuntimeDownloadSession['fetch']>().mockResolvedValue(new Response('archive'))
    const session: RuntimeDownloadSession = {
      fetch,
      webRequest: { onBeforeRequest: (filter: WebRequestFilter | Listener | null, listener?: Listener | null) => {
        const selected = listener ?? (typeof filter === 'function' ? filter : null)
        if (selected !== null) listeners.push(selected)
      } },
    }
    const transport = createRuntimeFetch(session)
    const callback = vi.fn()
    const details: OnBeforeRequestListenerDetails = { id: 1, url: 'http://downgrade.test/archive', method: 'GET', resourceType: 'other', referrer: '', timestamp: 0, uploadData: [] }
    const guard = listeners[0]
    if (guard === undefined) throw new Error('HTTPS guard not registered')
    guard(details, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    guard({ ...details, url: 'https://nodejs.org/archive' }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: false })
    const signal = new AbortController().signal
    await transport('https://nodejs.org/archive', signal)
    expect(fetch).toHaveBeenCalledWith('https://nodejs.org/archive', { signal, redirect: 'follow' })
    await expect(transport('http://downgrade.test/archive', signal)).rejects.toThrow(/HTTPS/u)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
