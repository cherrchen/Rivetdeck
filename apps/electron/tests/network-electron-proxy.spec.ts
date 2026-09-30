import { describe, expect, it, vi } from 'vitest'
import { ElectronProxyApplier } from '../src/network/electron-proxy.ts'

function session() {
  return { setProxy: vi.fn().mockResolvedValue(undefined), closeAllConnections: vi.fn().mockResolvedValue(undefined) }
}

describe('Electron network application', () => {
  it('leaves Default sessions and app untouched', async () => {
    const application = { setProxy: vi.fn() }
    const primary = session()
    const updater = session()
    const applier = new ElectronProxyApplier(application, primary)
    await applier.register(updater, 'updater')
    await applier.apply('default')
    expect(application.setProxy).not.toHaveBeenCalled()
    expect(primary.setProxy).not.toHaveBeenCalled()
    expect(updater.setProxy).not.toHaveBeenCalled()
  })

  it('isolates updater failures while preserving one selected upstream route', async () => {
    const application = { setProxy: vi.fn().mockResolvedValue(undefined) }
    const primary = session()
    const updater = session()
    const applier = new ElectronProxyApplier(application, primary)
    await applier.register(updater, 'updater')
    await applier.apply('system', { host: '127.0.0.1', port: 4123 }, { host: '127.0.0.1', port: 4124 })
    const expected = { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:4123' }
    for (const target of [application, primary]) expect(target.setProxy).toHaveBeenCalledWith(expected)
    expect(updater.setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:4124' })
    expect(primary.closeAllConnections).toHaveBeenCalledOnce()
    expect(updater.closeAllConnections).toHaveBeenCalledOnce()
    const late = session()
    await applier.register(late)
    expect(late.setProxy).toHaveBeenCalledWith(expected)
    await applier.closeConnections()
    expect(late.closeAllConnections).toHaveBeenCalledOnce()
  })

  it('sets Direct explicitly and rejects Managed without a Gateway', async () => {
    const application = { setProxy: vi.fn().mockResolvedValue(undefined) }
    const primary = session()
    const applier = new ElectronProxyApplier(application, primary)
    await expect(applier.apply('manual')).rejects.toThrow(/ready Gateway/)
    expect(application.setProxy).not.toHaveBeenCalled()
    await applier.apply('direct')
    expect(application.setProxy).toHaveBeenCalledWith({ mode: 'direct' })
    expect(primary.setProxy).toHaveBeenCalledWith({ mode: 'direct' })
  })
})
