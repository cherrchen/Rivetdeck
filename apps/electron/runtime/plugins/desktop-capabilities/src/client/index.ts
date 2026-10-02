/**
 * Desktop Client composition root: provide ctx.desktop, then mount feature plugins.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { DesktopCapabilitiesService } from './service.ts'
import * as directoryPicker from './features/directory-picker/index.ts'
import * as brand from './features/brand/index.ts'
import * as networkSettings from './features/network-settings/index.ts'
import * as runtimeSettings from './features/runtime-settings/index.ts'
import * as pluginManager from './features/plugin-manager/index.ts'

export type { DesktopCapabilitiesContract } from './contract.ts'
export type {
  DesktopNetworkConfigInput, DesktopNetworkDiagnostics, DesktopNetworkMode,
  DesktopNetworkReloadResult, DesktopNetworkRetryResult, DesktopNetworkState,
  DesktopNetworkTestRequest, DesktopNetworkTestResult, DesktopNetworkTestItem, ManualProxyInput,
  SanitizedManualProxy,
} from './contract.ts'
export { createDesktopCapabilities, requireDesktopBridge } from './contract.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Approved desktop capabilities for Electron feature plugins. */
    desktop: import('./contract.ts').DesktopCapabilitiesContract
  }
}

/**
 * Provide `ctx.desktop`, then mount each Desktop feature as a child fiber.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.plugin(DesktopCapabilitiesService)
  ctx.plugin(directoryPicker)
  ctx.plugin(brand)
  ctx.plugin(networkSettings)
  ctx.plugin(runtimeSettings)
  ctx.plugin(pluginManager)
}
