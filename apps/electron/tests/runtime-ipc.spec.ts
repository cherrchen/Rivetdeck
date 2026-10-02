import { describe, expect, it, vi } from 'vitest'
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const events = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0' },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    on: (name: string, handler: (...args: unknown[]) => unknown) => events.set(name, handler),
  },
  clipboard: {}, dialog: {}, nativeTheme: {}, Notification: {}, shell: {},
}))
import { installDesktopIpc } from '../src/ipc.ts'
import { DesktopIpcChannel } from '../src/bridge-types.ts'
import { DesktopServices } from '../src/desktop/services.ts'
import { RuntimeManager } from '../src/toolchains/manager.ts'
import { HttpHarnessTransport } from '../src/harness/transport.ts'

describe('closed runtime IPC', () => {
  it('guards trust and validates runtime selectors before privileged operations', async () => {
    const manager = new RuntimeManager({ userData: '/unused', fetch: async () => new Response() })
    const install = vi.spyOn(manager, 'install').mockResolvedValue()
    const desktop = new DesktopServices({
      getRuntimes: () => manager, getWindow: () => undefined, getUpdater: () => undefined,
      getNetwork: () => undefined, showMainWindow: () => {}, relaunch: async () => {},
    })
    installDesktopIpc(new HttpHarnessTransport(), desktop, contents => 'trusted' in contents)
    const invoke = handlers.get(DesktopIpcChannel.runtimesInstall)!
    await expect(invoke({ sender: {} }, 'node')).rejects.toThrow(/untrusted/u)
    await expect(invoke({ sender: { trusted: true } }, 'core')).rejects.toThrow(/invalid runtime/u)
    expect(install).not.toHaveBeenCalled()
    await invoke({ sender: { trusted: true } }, 'python')
    expect(install).toHaveBeenCalledWith('python')
    install.mockRestore()
    await manager.shutdown()
  })
})
