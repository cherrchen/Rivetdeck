import type { DesktopNetworkErrorCode, DesktopNetworkErrorSummary } from './errors.ts'

declare const NETWORK_BRAND: unique symbol

/** Persisted and effective Desktop network modes. */
export type DesktopNetworkMode = 'default' | 'direct' | 'system' | 'manual'

/** Reference to encrypted Desktop-owned secret bytes. */
export type SecretRef = string & { readonly [NETWORK_BRAND]: 'DesktopNetworkSecretRef' }

/** Reference used for the single v1 Manual proxy password. */
export const MANUAL_PROXY_PASSWORD_REF = 'network.manual.proxy.password.v1' as SecretRef

/** Renderer-directed mutation of a password that is never returned to it. */
export type PasswordChange =
  | { action: 'keep' }
  | { action: 'replace'; value: string }
  | { action: 'remove' }

/** Manual HTTP or HTTPS proxy input accepted from the trusted Renderer. */
export interface ManualAuthenticatedProxyInput {
  protocol: 'http' | 'https'
  host: string
  port: number
  username?: string
  passwordChange?: PasswordChange
}

/** Manual SOCKS5 input; v1 deliberately has no credential fields. */
export interface ManualSocks5ProxyInput {
  protocol: 'socks5'
  host: string
  port: number
}

/** Exactly one Manual proxy endpoint. */
export type ManualProxyInput = ManualAuthenticatedProxyInput | ManualSocks5ProxyInput

/** User-editable diagnostic endpoints. */
export interface DesktopNetworkTestSettings {
  internet204Url: string
  githubUrl: string
  llm?: {
    providerId?: string
    healthUrl?: string
  }
}

/** Complete input saved by the Network settings UI. */
export interface DesktopNetworkConfigInput {
  mode: DesktopNetworkMode
  manual?: ManualProxyInput
  proxyAgentTraffic?: boolean
  tests?: Partial<DesktopNetworkTestSettings>
}

/** Password-free persisted HTTP or HTTPS endpoint. */
export interface PersistedAuthenticatedProxy {
  protocol: 'http' | 'https'
  host: string
  port: number
  username?: string
  credentialRef?: SecretRef
}

/** Password-free persisted SOCKS5 endpoint. */
export interface PersistedSocks5Proxy {
  protocol: 'socks5'
  host: string
  port: number
}

/** Retained Manual endpoint in Desktop preferences. */
export type PersistedManualProxy = PersistedAuthenticatedProxy | PersistedSocks5Proxy

/** Manual endpoint safe to return to Renderer code. */
export type SanitizedManualProxy =
  | {
    protocol: 'http' | 'https'
    host: string
    port: number
    username?: string
    hasPassword: boolean
  }
  | PersistedSocks5Proxy

/** Source that selected a direct or proxy route. */
export type RouteSource =
  | 'manual'
  | 'system-manual'
  | 'pac'
  | 'wpad'
  | 'system-bypass'
  | 'system-direct'

/** Route metadata safe for diagnostics and incidents. */
export interface SanitizedResolvedRoute {
  kind: 'direct' | 'http' | 'https' | 'socks5'
  host?: string
  port?: number
  source?: RouteSource
}

/** Why a network epoch replaced its predecessor. */
export type NetworkEpochReason =
  | 'startup'
  | 'manual-config-applied'
  | 'system-policy-changed'
  | 'network-changed'
  | 'pac-reloaded'
  | 'user-reload'

/** Sanitized identity and fingerprints of one network configuration generation. */
export interface NetworkEpochSummary {
  id: string
  startedAt: string
  reason: NetworkEpochReason
  policyFingerprint?: string
  networkFingerprint?: string
}

/** Stages used to distinguish proxy failures from target and offline failures. */
export type NetworkFailureStage =
  | 'system-resolution'
  | 'pac-fetch'
  | 'pac-evaluation'
  | 'proxy-dns'
  | 'proxy-connect'
  | 'proxy-tls'
  | 'proxy-auth'
  | 'socks-handshake'
  | 'target-connect'
  | 'target-tls'
  | 'http'
  | 'offline'
  | 'unknown'

/** Classified runtime failure before product incident handling. */
export interface DesktopNetworkFailure {
  code: DesktopNetworkErrorCode
  stage: NetworkFailureStage
  retryable: boolean
  proxyFailure: boolean
  message: string
  platformCode?: string
}

/** Incident summary safe to return to the Renderer. */
export interface DesktopNetworkIncidentSummary {
  id: string
  createdAt: string
  epochId: string
  mode: 'system' | 'manual'
  route?: SanitizedResolvedRoute
  failure: DesktopNetworkFailure
  dialogShown: boolean
  resolvedAt?: string
}

/** One real-traffic Basic challenge; its identifier expires on epoch change. */
export interface ProxyCredentialChallenge {
  id: string
  mode: 'manual' | 'system'
  proxy: { host: string; port: number; kind: 'http' | 'https' }
  scheme: 'Basic'
  rejected: boolean
  canPersist: boolean
}

/** New credentials flow only from the secure prompt to Electron Main. */
export type ProxyCredentialSubmission =
  | { action: 'cancel' }
  | { action: 'use-once' | 'save-securely'; username: string; password: string }

/** System proxy provider selected for the current platform. */
export type SystemProxyBackend =
  | 'windows-winhttp'
  | 'macos-cfnetwork'
  | 'linux-gnome'
  | 'linux-kde'
  | 'unsupported'

/** Origin of the current system policy. */
export type SystemProxyPolicySource = 'none' | 'manual' | 'pac' | 'wpad' | 'mixed' | 'unknown'

/** Runtime capability matrix returned by the native helper. */
export interface DesktopNetworkRuntimeCapabilities {
  manual: { http: boolean; https: boolean; socks5: boolean; socks5Auth: boolean }
  system: { manual: boolean; pac: boolean; wpad: boolean; watchers: boolean }
  auth: { basic: boolean; digest: boolean; ntlm: boolean; negotiate: boolean }
}

/** Lifecycle state of the native network helper. */
export interface DesktopNetworkRuntimeState {
  status: 'inactive' | 'starting' | 'ready' | 'degraded' | 'failed' | 'stopped'
  gateway?: { host: '127.0.0.1' | '::1'; port: number }
  protocolVersion?: number
  systemBackend?: SystemProxyBackend
  capabilities?: DesktopNetworkRuntimeCapabilities
  lastError?: DesktopNetworkErrorSummary
}

/** Secret storage state interpreted by Electron Main. */
export interface DesktopSecureStorageState {
  available: boolean
  persistent: boolean
  backend?: 'keychain' | 'dpapi' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'portal_secret' | 'basic_text' | 'unknown'
  warning?: 'plaintext-backend' | 'temporarily-unavailable' | 'unavailable'
}

/** Warning produced while loading a partially usable preferences file. */
export interface DesktopNetworkPreferenceWarning {
  code: 'unreadable' | 'invalid-root' | 'unsupported-version' | 'invalid-network'
  message: string
}

/** Sanitized settings state exposed by the controller. */
export interface DesktopNetworkState {
  configuredMode: DesktopNetworkMode
  effectiveMode: DesktopNetworkMode
  startupOverride?: 'default'
  manual?: SanitizedManualProxy
  lastManual?: SanitizedManualProxy
  proxyAgentTraffic: boolean
  restartRequired: boolean
  preferencesWarning?: DesktopNetworkPreferenceWarning
  runtime: DesktopNetworkRuntimeState
  secureStorage: DesktopSecureStorageState
  epoch?: NetworkEpochSummary
  lastIncident?: DesktopNetworkIncidentSummary
  /** Navigation request from a failure dialog; never changes network policy. */
  openSettingsRequestId?: string
  testSettings: DesktopNetworkTestSettings
}

/** One Connection Test invocation. */
export interface DesktopNetworkTestRequest {
  tests: Array<'proxy' | 'internet' | 'github' | 'llm'>
  overrides?: {
    internet204Url?: string
    githubUrl?: string
    llm?: { providerId?: string; healthUrl?: string }
  }
}

/** Stage reached by a diagnostic connection. */
export type NetworkTestStage = NetworkFailureStage | 'complete'

/** One sanitized diagnostic result. */
export interface DesktopNetworkTestItem {
  kind: 'proxy' | 'internet' | 'github' | 'llm'
  status: 'reachable' | 'unreachable' | 'skipped' | 'not-configured'
  latencyMs?: number
  httpStatus?: number
  route?: SanitizedResolvedRoute
  stage?: NetworkTestStage
  error?: DesktopNetworkErrorSummary
}

/** Complete result of one diagnostic test request. */
export interface DesktopNetworkTestResult {
  startedAt: string
  finishedAt: string
  results: DesktopNetworkTestItem[]
}

/** Sanitized runtime and policy details shown only in Advanced settings. */
export interface DesktopNetworkDiagnostics {
  mode: DesktopNetworkMode
  epoch?: NetworkEpochSummary
  runtime: { status: DesktopNetworkRuntimeState['status']; gateway?: string }
  system?: {
    backend: SystemProxyBackend
    policySource: SystemProxyPolicySource
    selectedRoute?: SanitizedResolvedRoute
    alternativeRoutes: SanitizedResolvedRoute[]
    pac: { configured: boolean; state: 'none' | 'loading' | 'loaded' | 'failed' }
    policyFingerprint: string
    error?: DesktopNetworkErrorSummary
  }
  lastFailure?: DesktopNetworkIncidentSummary
}

/** Result of explicitly refreshing the active System policy. */
export interface DesktopNetworkReloadResult {
  previousEpochId?: string
  epoch: NetworkEpochSummary
  system: DesktopNetworkDiagnostics['system']
}

/** User action that permits the same selected route to be tried again. */
export interface DesktopNetworkRetryResult {
  status: 'started' | 'no-failure' | 'stale-incident'
  incidentId?: string
}

/** Runtime-effective Manual route; password exists only in Main/runtime memory. */
export type RuntimeManualProxy =
  | {
    protocol: 'http' | 'https'
    host: string
    port: number
    username?: string
    password?: string
  }
  | PersistedSocks5Proxy

/** Complete configuration understood by the native runtime. */
export type RuntimeNetworkConfig =
  | { mode: 'direct'; strictFallback: true }
  | { mode: 'system'; strictFallback: true }
  | { mode: 'manual'; strictFallback: true; proxy: RuntimeManualProxy }
