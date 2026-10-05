import { describe, expect, it } from 'vitest'
import {
  DesktopIpcChannel,
  RENDERER_ENTRY_URL,
  RENDERER_ORIGIN,
  RENDERER_SCHEME,
} from '../src/bridge-types.ts'
import { resolveRendererRoot, shouldProxyHarnessRequest } from '../src/protocol.ts'

describe('desktop bridge constants', () => {
  it('keeps the renderer origin on localhost for upstream loopback gates', () => {
    expect(RENDERER_SCHEME).toBe('dsh-electron')
    expect(RENDERER_ORIGIN).toBe('dsh-electron://localhost')
    expect(RENDERER_ENTRY_URL).toBe('dsh-electron://localhost/index.html')
    expect(new URL(RENDERER_ORIGIN).hostname).toBe('localhost')
  })

  it('exposes a closed IPC channel set', () => {
    expect(Object.values(DesktopIpcChannel)).toEqual([
      'desktop:runtimes:get-state', 'desktop:runtimes:install', 'desktop:runtimes:cancel',
      'desktop:runtimes:remove', 'desktop:runtimes:complete-onboarding', 'desktop:runtimes:subscribe',
      'deepseek-desktop:host:getBootstrap',
      'deepseek-desktop:host:request',
      'deepseek-desktop:host:openStream',
      'deepseek-desktop:app:getVersion',
      'deepseek-desktop:app:getPlatform',
      'deepseek-desktop:app:relaunch',
      'deepseek-desktop:dialog:pickDirectory',
      'deepseek-desktop:clipboard:readText',
      'deepseek-desktop:clipboard:writeText',
      'deepseek-desktop:shell:openExternal',
      'deepseek-desktop:shell:openPath',
      'deepseek-desktop:shell:showItemInFolder',
      'deepseek-desktop:notification:show',
      'deepseek-desktop:updater:check',
      'deepseek-desktop:updater:download',
      'deepseek-desktop:updater:install',
      'deepseek-desktop:updater:getState',
      'deepseek-desktop:updater:subscribe',
      'deepseek-desktop:theme:getState',
      'deepseek-desktop:theme:subscribe',
      'deepseek-desktop:window:minimize',
      'deepseek-desktop:window:maximize',
      'deepseek-desktop:window:close',
      'deepseek-desktop:window:getState',
      'deepseek-desktop:network:getState',
      'deepseek-desktop:network:saveAndRestart',
      'deepseek-desktop:network:restoreDefaultAndRestart',
      'deepseek-desktop:network:reloadSystemProxy',
      'deepseek-desktop:network:test',
      'deepseek-desktop:network:getDiagnostics',
      'deepseek-desktop:network:retryLastFailure',
      'deepseek-desktop:network:removeManualPassword',
      'deepseek-desktop:network:subscribe',
    ])
  })

  it('resolves the renderer dist under the application root', () => {
    expect(resolveRendererRoot('/app/root').replaceAll('\\', '/')).toBe('/app/root/dist/renderer')
  })

  it('proxies plugin-owned RPC channels without treating their paths as renderer files', () => {
    expect(shouldProxyHarnessRequest('POST', '/git/discover')).toBe(true)
    expect(shouldProxyHarnessRequest('GET', '/git/discover')).toBe(false)
    expect(shouldProxyHarnessRequest('GET', '/api/remote.mux')).toBe(true)
    expect(shouldProxyHarnessRequest('GET', '/plugins/git/client.js')).toBe(true)
    expect(shouldProxyHarnessRequest('HEAD', '/index.html')).toBe(false)
  })
})
