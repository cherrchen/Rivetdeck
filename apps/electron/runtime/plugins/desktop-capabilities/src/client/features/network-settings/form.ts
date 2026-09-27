import type {
  DesktopNetworkConfigInput, DesktopNetworkMode, DesktopNetworkState,
} from '../../contract.ts'

/** Browser-only edit buffer; the saved password never enters it. */
export interface NetworkDraft {
  mode: DesktopNetworkMode
  protocol: 'http' | 'https' | 'socks5'
  host: string
  port: string
  username: string
  password: string
  passwordAction: 'keep' | 'replace' | 'remove'
  proxyAgentTraffic: boolean
  internet204Url: string
  githubUrl: string
  providerId: string
  healthUrl: string
}

/** Convert sanitized Main state into an editable buffer. */
export function draftFromState(state: DesktopNetworkState): NetworkDraft {
  const manual = state.manual ?? state.lastManual
  return {
    mode: state.configuredMode,
    protocol: manual?.protocol ?? 'http', host: manual?.host ?? '',
    port: manual === undefined ? '' : String(manual.port),
    username: manual !== undefined && manual.protocol !== 'socks5' ? manual.username ?? '' : '',
    password: '', passwordAction: 'keep', proxyAgentTraffic: state.proxyAgentTraffic,
    internet204Url: state.testSettings.internet204Url, githubUrl: state.testSettings.githubUrl,
    providerId: state.testSettings.llm?.providerId ?? '', healthUrl: state.testSettings.llm?.healthUrl ?? '',
  }
}

/** Submit one active Manual endpoint and password operation, or retain a hidden draft. */
export function inputFromDraft(draft: NetworkDraft): DesktopNetworkConfigInput {
  const manual = draft.mode !== 'manual' ? undefined : draft.protocol === 'socks5'
    ? { protocol: 'socks5' as const, host: draft.host, port: Number(draft.port) }
    : { protocol: draft.protocol, host: draft.host, port: Number(draft.port),
      ...(draft.username.trim() === '' ? {} : { username: draft.username.trim() }),
      passwordChange: draft.passwordAction === 'replace'
        ? { action: 'replace' as const, value: draft.password }
        : { action: draft.passwordAction },
    }
  return {
    mode: draft.mode,
    ...(manual === undefined ? {} : { manual }),
    proxyAgentTraffic: draft.mode === 'system' || draft.mode === 'manual' ? draft.proxyAgentTraffic : false,
    tests: {
      internet204Url: draft.internet204Url, githubUrl: draft.githubUrl,
      llm: { ...(draft.providerId === '' ? {} : { providerId: draft.providerId }),
        ...(draft.healthUrl === '' ? {} : { healthUrl: draft.healthUrl }) },
    },
  }
}

/** Validate visible fields before submission; Main repeats validation. */
export function draftErrors(draft: NetworkDraft): {
  host?: boolean
  port?: boolean
  internet204Url?: boolean
  githubUrl?: boolean
  healthUrl?: boolean
} {
  const host = draft.mode === 'manual' && (draft.host.trim() === '' || /[:][/][/]|[/@?#]|\s/u.test(draft.host))
  const port = draft.mode === 'manual' && (!/^[0-9]+$/u.test(draft.port) || Number(draft.port) < 1 || Number(draft.port) > 65_535)
  return {
    ...(host ? { host: true } : {}), ...(port ? { port: true } : {}),
    ...(!validHttpUrl(draft.internet204Url) ? { internet204Url: true } : {}),
    ...(!validHttpUrl(draft.githubUrl) ? { githubUrl: true } : {}),
    ...(draft.healthUrl !== '' && !validHttpUrl(draft.healthUrl) ? { healthUrl: true } : {}),
  }
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
  } catch { return false }
}
