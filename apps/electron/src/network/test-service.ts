import type {
  DesktopNetworkTestItem,
  DesktopNetworkTestRequest,
  DesktopNetworkTestResult,
  DesktopNetworkTestSettings,
  SanitizedResolvedRoute,
} from './domain.ts'
import { DesktopNetworkConfigError } from './errors.ts'
import { classifyNetworkFailure } from './failure.ts'
import { normalizeHttpUrl } from './validation.ts'

const TEST_KINDS = ['proxy', 'internet', 'github', 'llm'] as const
const TEST_TIMEOUT_MS = 12_000

/** Validated diagnostic request accepted across the IPC boundary. */
export function parseNetworkTestRequest(value: unknown): DesktopNetworkTestRequest {
  if (!isRecord(value) || !Array.isArray(value.tests) || value.tests.length > TEST_KINDS.length
    || !value.tests.every((kind): kind is typeof TEST_KINDS[number] => TEST_KINDS.some(allowed => allowed === kind))
    || new Set(value.tests).size !== value.tests.length) {
    throw new DesktopNetworkConfigError('INVALID_CONFIG', 'Select valid connection tests.')
  }
  const overrides = value.overrides
  if (overrides !== undefined && !isRecord(overrides)) throw new DesktopNetworkConfigError('INVALID_CONFIG', 'Invalid test settings.')
  if (overrides !== undefined) {
    for (const key of Object.keys(overrides)) if (!['internet204Url', 'githubUrl', 'llm'].includes(key)) {
      throw new DesktopNetworkConfigError('INVALID_CONFIG', 'Invalid test settings.')
    }
    if (overrides.internet204Url !== undefined && typeof overrides.internet204Url !== 'string') throw new DesktopNetworkConfigError('INVALID_CONFIG', 'Invalid Internet URL.')
    if (overrides.githubUrl !== undefined && typeof overrides.githubUrl !== 'string') throw new DesktopNetworkConfigError('INVALID_CONFIG', 'Invalid GitHub URL.')
    if (overrides.llm !== undefined && (!isRecord(overrides.llm)
      || Object.keys(overrides.llm).some(key => !['providerId', 'healthUrl'].includes(key))
      || (overrides.llm.providerId !== undefined && typeof overrides.llm.providerId !== 'string')
      || (overrides.llm.healthUrl !== undefined && typeof overrides.llm.healthUrl !== 'string'))) {
      throw new DesktopNetworkConfigError('INVALID_CONFIG', 'Invalid LLM test settings.')
    }
  }
  return {
    tests: value.tests,
    ...(overrides === undefined ? {} : {
      overrides: {
        ...(typeof overrides.internet204Url === 'string' ? { internet204Url: overrides.internet204Url } : {}),
        ...(typeof overrides.githubUrl === 'string' ? { githubUrl: overrides.githubUrl } : {}),
        ...(isRecord(overrides.llm) ? {
          llm: {
            ...(typeof overrides.llm.providerId === 'string' ? { providerId: overrides.llm.providerId } : {}),
            ...(typeof overrides.llm.healthUrl === 'string' ? { healthUrl: overrides.llm.healthUrl } : {}),
          },
        } : {}),
      },
    }),
  }
}

/** Fetch injected by Main with an isolated Session whose Gateway suppresses incidents. */
export type NetworkDiagnosticFetch = (url: string, signal: AbortSignal) => Promise<{ status: number; networkErrorCode?: string }>

/** Run explicit GET probes against exactly one configured endpoint per kind. */
export async function runNetworkTests(
  request: DesktopNetworkTestRequest,
  settings: DesktopNetworkTestSettings,
  fetchOne: NetworkDiagnosticFetch,
  routeForTest?: () => Promise<SanitizedResolvedRoute | undefined>,
): Promise<DesktopNetworkTestResult> {
  const startedAt = new Date().toISOString()
  const internetUrl = normalizeHttpUrl(request.overrides?.internet204Url ?? settings.internet204Url, 'Internet URL')
  const githubUrl = normalizeHttpUrl(request.overrides?.githubUrl ?? settings.githubUrl, 'GitHub URL')
  const llm = request.overrides?.llm ?? settings.llm
  const llmUrl = llm?.providerId && llm.healthUrl
    ? normalizeHttpUrl(llm.healthUrl, 'LLM health URL') : undefined
  const results: DesktopNetworkTestItem[] = []
  for (const kind of request.tests) {
    if (kind === 'llm' && llmUrl === undefined) {
      results.push({ kind, status: 'not-configured' })
      continue
    }
    const url = kind === 'github' ? githubUrl : kind === 'llm' ? llmUrl : internetUrl
    if (url === undefined) throw new Error('desktop network: missing test URL')
    const started = performance.now()
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort() }, TEST_TIMEOUT_MS)
    try {
      const response = await fetchOne(url, abort.signal)
      const route = await routeForTest?.().catch(() => undefined)
      if (response.networkErrorCode !== undefined) {
        const failure = classifyNetworkFailure({ code: response.networkErrorCode })
        results.push({ kind, status: 'unreachable', latencyMs: Math.round(performance.now() - started),
          httpStatus: response.status, ...(route === undefined ? {} : { route }), stage: failure.stage,
          error: { code: failure.code, message: failure.message, retryable: failure.retryable, stage: failure.stage } })
        continue
      }
      results.push({ kind, status: 'reachable', latencyMs: Math.round(performance.now() - started), httpStatus: response.status,
        ...(route === undefined ? {} : { route }), stage: 'complete' })
    } catch {
      const route = await routeForTest?.().catch(() => undefined)
      results.push({ kind, status: 'unreachable', latencyMs: Math.round(performance.now() - started),
        ...(route === undefined ? {} : { route }), stage: 'unknown',
        error: { code: abort.signal.aborted ? 'TEST_TIMEOUT' : 'UNKNOWN',
          message: abort.signal.aborted ? 'Connection test timed out.' : 'Connection test failed.', retryable: true, stage: 'unknown' } })
    } finally { clearTimeout(timer) }
  }
  return { startedAt, finishedAt: new Date().toISOString(), results }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
