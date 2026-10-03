import { useEffect, useMemo, useState } from 'react'
import {
  Button, DisclosureRow, IconChevronDownOutlineMedium, IconGlobeOutlineMedium, IconQuestionOutlineMedium,
  Input, LinkIconMedium, Menu, Modal, Pill, SettingsForm, IconLoadingOutlineMedium, StateDot, Switch, Toast, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DesktopCapabilitiesContract, DesktopNetworkDiagnostics,
  DesktopNetworkState, DesktopNetworkTestItem, DesktopNetworkTestResult,
} from '../../contract.ts'
import { draftErrors, draftFromState, inputFromDraft, type NetworkDraft } from './form.ts'
import type { NetworkLocaleKey } from './locales.ts'
import { RuntimeSettings, type RuntimeSettingsInjected } from '../runtime-settings/RuntimeSettings.tsx'
import css from './NetworkSettingsSection.module.css'

const MODES = ['default', 'direct', 'system', 'manual'] as const
const KINDS = ['proxy', 'internet', 'github', 'llm'] as const
const HELP_URL = 'https://github.com/cherrchen/deepseek-harness-electron/blob/develop/docs/electron/network-settings.md'
const MODE_HINT = {
  default: 'defaultHint', direct: 'directHint', system: 'systemHint', manual: 'manualHint',
} as const satisfies Record<typeof MODES[number], NetworkLocaleKey>

/** Capabilities and current registered LLM providers injected by the plugin. */
export interface NetworkSettingsInjected {
  runtimeSettings?: RuntimeSettingsInjected & PropsLocale<'settings.runtimesElectron'>
  network: DesktopCapabilitiesContract['network']
  shell: DesktopCapabilitiesContract['shell']
  providers: () => Promise<Array<{ id: string; name: string }>>
}

/** Settings section props assembled by the shared Settings shell. */
export type NetworkSettingsProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.networkElectron'> & InjectFace<NetworkSettingsInjected>

/** Format only sanitized route metadata. */
function routeText(route: { kind: string; host?: string; port?: number } | undefined): string {
  if (route === undefined) return '—'
  if (route.kind === 'direct') return 'DIRECT'
  return `${route.kind.toUpperCase()} ${route.host ?? '?'}:${route.port ?? '?'}`
}

/** Map a diagnostic status onto the shared state dot. */
function testDot(status: string): StateDotState {
  if (status === 'testing') return 'ongoing'
  if (status === 'reachable') return 'done'
  if (status === 'unreachable') return 'error'
  if (status === 'skipped') return 'warning'
  return 'idle'
}

/** Network settings, explicit diagnostics, and restart-only mutations. */
export function NetworkSettingsSection({ network, shell, providers: readProviders, runtimeSettings, t }: NetworkSettingsProps) {
  const [state, setState] = useState<DesktopNetworkState>()
  const [draft, setDraft] = useState<NetworkDraft>()
  const [initial, setInitial] = useState<NetworkDraft>()
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([])
  const [diagnostics, setDiagnostics] = useState<DesktopNetworkDiagnostics>()
  const [testResult, setTestResult] = useState<DesktopNetworkTestResult>()
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [help, setHelp] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [providerOpen, setProviderOpen] = useState(false)
  const [storagePrompt, setStoragePrompt] = useState(false)
  const [restorePrompt, setRestorePrompt] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let live = true
    void network.getState().then((value) => {
      if (!live) return
      setState(value)
      const next = draftFromState(value)
      setDraft(current => current ?? next)
      setInitial(current => current ?? next)
      setLoading(false)
    }).catch(() => { if (live) { setError(t('loadError')); setLoading(false) } })
    void readProviders().then((rows) => { if (live) setProviders(rows) }).catch(() => undefined)
    const dispose = network.subscribe((value) => { if (live) setState(value) })
    return () => { live = false; dispose() }
  }, [network])

  useEffect(() => {
    if (!advanced) return
    let live = true
    void network.getDiagnostics().then((value) => { if (live) setDiagnostics(value) })
      .catch(() => { if (live) setError(t('diagnosticsError')) })
    return () => { live = false }
  }, [advanced, network, state?.epoch?.id])

  const errors = useMemo(() => draft === undefined ? {} : draftErrors(draft), [draft])
  const dirty = draft !== undefined && initial !== undefined && JSON.stringify(draft) !== JSON.stringify(initial)
  const valid = Object.keys(errors).length === 0
  const update = (patch: Partial<NetworkDraft>) => {
    setDraft(current => current === undefined ? current : { ...current, ...patch })
    setError(undefined)
  }

  const save = async (discard = false) => {
    if (draft === undefined || !valid) return
    if (!discard && draft.passwordAction === 'replace' && !state?.secureStorage.persistent) {
      setStoragePrompt(true)
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      await network.saveAndRestart(inputFromDraft(draft), discard)
    } catch (cause) {
      const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
      if (code === 'SECURE_STORAGE_UNAVAILABLE' || code === 'SECURE_STORAGE_PLAINTEXT_BACKEND') setStoragePrompt(true)
      else setError(t('saveError'))
    } finally { setSaving(false) }
  }

  const test = async () => {
    if (draft === undefined) return
    setTesting(true)
    setTestResult(undefined)
    setError(undefined)
    try {
      setTestResult(await network.test({ tests: [...KINDS], overrides: {
        internet204Url: draft.internet204Url, githubUrl: draft.githubUrl,
        llm: { ...(draft.providerId === '' ? {} : { providerId: draft.providerId }),
          ...(draft.healthUrl === '' ? {} : { healthUrl: draft.healthUrl }) },
      } }))
      if (advanced) void network.getDiagnostics().then(setDiagnostics).catch(() => setError(t('diagnosticsError')))
    } catch { setError(t('testError')) }
    finally { setTesting(false) }
  }

  const reload = async () => {
    setError(undefined)
    try {
      await network.reloadSystemProxy()
      setDiagnostics(await network.getDiagnostics())
      setNotice(t('reloaded'))
    } catch { setError(t('reloadError')) }
  }

  const restore = async () => {
    setRestorePrompt(false)
    setSaving(true)
    try { await network.restoreDefaultAndRestart() }
    catch { setError(t('saveError')); setSaving(false) }
  }

  const retry = async () => {
    try {
      await network.retryLastFailure()
      setNotice(t('retryHint'))
    } catch { setError(t('reloadError')) }
  }

  if (loading) return <div className={css.loading}><IconLoadingOutlineMedium className={css.spinner} /></div>
  if (draft === undefined) return <div className={css.section} role="alert">{error ?? t('loadError')}</div>
  const manual = state?.manual ?? state?.lastManual
  const hasPassword = manual !== undefined && manual.protocol !== 'socks5' && manual.hasPassword
  const resultFor = (kind: typeof KINDS[number]): DesktopNetworkTestItem | undefined => testResult?.results.find(item => item.kind === kind)
  const providerLabel = providers.find(provider => provider.id === draft.providerId)?.name ?? t('providerNone')
  const modeSelector = (
    <button type="button" className={css.selector} aria-haspopup="menu" aria-expanded={modeOpen}
      onClick={() => { setModeOpen(open => !open) }}>
      {t(draft.mode)}
      <IconChevronDownOutlineMedium className={css.chevron} />
    </button>
  )
  const providerSelector = (
    <button type="button" className={css.selector} aria-haspopup="menu" aria-expanded={providerOpen}
      onClick={() => { setProviderOpen(open => !open) }}>
      {providerLabel}
      <IconChevronDownOutlineMedium className={css.chevron} />
    </button>
  )
  return (
    <section className={css.section} aria-label={t('title')}>
      <header className={css.header}><h2>{t('nav')}</h2></header>
      <h3 className={css.subheading}>{t('title')}</h3><p className={css.muted}>{t('intro')}</p>
      <SettingsForm state={{ available: true, writable: true, dirty, invalid: !valid, saving, failed: error !== undefined }}
        labels={{ unavailable: t('loadError'), readOnly: t('loadError'), saveFailed: error ?? t('saveError'), save: t('save'), saving: t('saving') }}
        onSave={() => { void save() }} onDiscard={() => {}}>
        <div className={css.controls}>
          {state?.lastIncident !== undefined && state.lastIncident.resolvedAt === undefined && <div className={css.statusRow} role="status">
            <StateDot state="warning" />
            <span><strong>{t('warning')}</strong> {state.lastIncident.failure.code}</span>
            <Button size="sm" variant="outline" onClick={() => { void retry() }}>{t('retry')}</Button>
          </div>}
          {state?.preferencesWarning !== undefined && <div className={css.statusRow} role="status">
            <StateDot state="warning" /><span>{state.preferencesWarning.message}</span>
          </div>}
          <div className={css.row}>
            <div className={css.rowText}>
              <div className={css.rowTitle}>{t('mode')}</div>
              <div className={css.desc}>{t(MODE_HINT[draft.mode])}</div>
            </div>
            <Menu open={modeOpen} onClose={() => { setModeOpen(false) }} align="end" portal anchor={modeSelector}
              selectedId={draft.mode}
              items={MODES.map(mode => ({ id: mode, label: t(mode) }))}
              onSelect={(id) => { setModeOpen(false); update({ mode: id as typeof MODES[number] }) }} />
          </div>

          {draft.mode === 'manual' && <div className={css.panel}>
            <div className={css.protocol} role="group" aria-label={t('protocol')}>
              <span className={css.fieldLabel}>{t('protocol')}</span>
              <div className={css.pills}>{(['http', 'https', 'socks5'] as const).map(protocol => (
                <Pill key={protocol} active={draft.protocol === protocol} aria-pressed={draft.protocol === protocol}
                  onClick={() => update({ protocol })}>{protocol.toUpperCase()}</Pill>
              ))}</div>
            </div>
            <div className={css.fields}>
              <label className={css.field}>{t('host')}<Input value={draft.host} onChange={event => update({ host: event.target.value })}
                aria-invalid={errors.host === true} aria-describedby={errors.host ? 'network-host-error' : undefined} placeholder="127.0.0.1" /></label>
              {errors.host && <span id="network-host-error" className={css.fieldError}>{t('hostError')}</span>}
              <label className={css.field}>{t('port')}<Input type="text" inputMode="numeric" value={draft.port} onChange={event => update({ port: event.target.value })}
                aria-invalid={errors.port === true} aria-describedby={errors.port ? 'network-port-error' : undefined} placeholder={draft.protocol === 'socks5' ? '7891' : '7890'} /></label>
              {errors.port && <span id="network-port-error" className={css.fieldError}>{t('portError')}</span>}
              {draft.protocol !== 'socks5' && <>
                <label className={css.field}>{t('username')}<Input value={draft.username} onChange={event => update({ username: event.target.value })} autoComplete="off" /></label>
                <label className={css.field}>{t('password')}<Input type="password" value={draft.password} autoComplete="new-password"
                  placeholder={hasPassword && draft.passwordAction === 'keep' ? '••••••••' : ''}
                  onChange={event => update({ password: event.target.value, passwordAction: event.target.value === '' ? 'keep' : 'replace' })} /></label>
                {hasPassword && <div className={css.passwordStatus}><span>{draft.passwordAction === 'remove' ? t('passwordRemoved') : t('storedPassword')}</span>
                  <Button size="sm" variant="ghost" onClick={() => update({ password: '', passwordAction: 'remove' })}>{t('removePassword')}</Button></div>}
                {!state?.secureStorage.persistent && <p className={css.muted}>{t('storageUnavailable')}</p>}
              </>}
            </div>
            <p className={css.muted}>{t(draft.protocol === 'https' ? 'httpsHint' : draft.protocol === 'socks5' ? 'socksHint' : 'manualHint')}</p>
          </div>}

          {(draft.mode === 'system' || draft.mode === 'manual') && <div className={css.row}>
            <div className={css.rowText}>
              <div className={css.rowTitle}>{t('agent')}</div>
              <div className={css.desc}>{t('agentHint')}</div>
            </div>
            <Switch checked={draft.proxyAgentTraffic} label={t('agent')} onChange={checked => update({ proxyAgentTraffic: checked })} />
          </div>}

          <div className={css.panel}>
            <h3>{t('tests')}</h3>
            <div className={css.testCards} role="list">{KINDS.map((kind) => {
              const item = resultFor(kind)
              const status = testing ? 'testing' : item?.status ?? (kind === 'llm' && providers.length === 0 ? 'notConfigured' : 'notTested')
              return <div key={kind} className={css.testCard} role="listitem" data-test-status={testDot(status)}>
                <strong className={css.testCardTitle}>{t(kind)}</strong>
                <span className={css.testCardStatus} role="status"><StateDot state={testDot(status)} />{t(status === 'not-configured' ? 'notConfigured' : status)}
                  {item?.httpStatus === undefined ? '' : ` · HTTP ${item.httpStatus}`}
                  {item?.latencyMs === undefined ? '' : ` · ${item.latencyMs} ms`}</span>
              </div>
            })}</div>
            {advanced && resultFor('proxy') !== undefined && <p className={css.muted}>
              {t('lastRoute')}: {routeText(resultFor('proxy')?.route)} · {t('handshakeStage')}: {resultFor('proxy')?.stage ?? '—'}
              {resultFor('proxy')?.error === undefined ? '' : ` · ${t('errorCode')}: ${resultFor('proxy')?.error?.code}`}
            </p>}
            <Button size="sm" variant="outline" onClick={() => { void test() }} disabled={testing || !!errors.internet204Url || !!errors.githubUrl || !!errors.healthUrl}>{t('testConnection')}</Button>
          </div>

          <DisclosureRow icon={<IconGlobeOutlineMedium aria-hidden="true" />} title={t('advanced')} open={advanced} expandable expandOnRowClick
            onToggle={() => { setAdvanced(open => !open) }}>
            <div className={css.disclosure}>
              <dl className={css.diagnostics}>
                <dt>{t('activeMode')}</dt><dd>{state?.effectiveMode ?? '—'}</dd>
                <dt>{t('runtime')}</dt><dd>{diagnostics?.runtime.status ?? state?.runtime.status ?? '—'}</dd>
                <dt>{t('epoch')}</dt><dd>{diagnostics?.epoch?.id ?? state?.epoch?.id ?? '—'}</dd>
                <dt>{t('lastRoute')}</dt><dd>{routeText(diagnostics?.system?.selectedRoute ?? state?.lastIncident?.route)}</dd>
                <dt>{t('lastFailure')}</dt><dd>{diagnostics?.lastFailure?.failure.code ?? '—'}</dd>
                <dt>{t('failureTime')}</dt><dd>{diagnostics?.lastFailure?.createdAt ?? '—'}</dd>
                {draft.mode === 'system' && <>
                  <dt>{t('backend')}</dt><dd>{diagnostics?.system?.backend ?? state?.runtime.systemBackend ?? '—'}</dd>
                  <dt>{t('policySource')}</dt><dd>{diagnostics?.system?.policySource ?? '—'}</dd>
                  <dt>{t('pac')}</dt><dd>{diagnostics?.system?.pac.state ?? '—'}</dd>
                  <dt>{t('fingerprint')}</dt><dd className={css.fingerprint}>{diagnostics?.system?.policyFingerprint ?? '—'}</dd>
                  <dt>{t('alternatives')}</dt><dd>{diagnostics?.system?.alternativeRoutes.map(routeText).join(', ') || '—'}<small>{t('alternativesHint')}</small></dd>
                </>}
              </dl>
              {draft.mode === 'system' && <div className={css.stack}><Button size="sm" variant="outline" onClick={() => { void reload() }} disabled={state?.effectiveMode !== 'system'}>{t('reload')}</Button><p className={css.muted}>{t('reloadHint')}</p></div>}
              <label className={css.field}>{t('internetUrl')}<Input value={draft.internet204Url} onChange={event => update({ internet204Url: event.target.value })}
                aria-invalid={errors.internet204Url === true} /></label>
              {errors.internet204Url && <span className={css.fieldError}>{t('urlError')}</span>}
              <label className={css.field}>{t('githubUrl')}<Input value={draft.githubUrl} onChange={event => update({ githubUrl: event.target.value })}
                aria-invalid={errors.githubUrl === true} /></label>
              {errors.githubUrl && <span className={css.fieldError}>{t('urlError')}</span>}
              <div className={css.row}>
                <div className={css.rowText}><div className={css.rowTitle}>{t('provider')}</div></div>
                <Menu open={providerOpen} onClose={() => { setProviderOpen(false) }} align="end" portal anchor={providerSelector}
                  selectedId={draft.providerId === '' ? 'none' : draft.providerId}
                  items={[{ id: 'none', label: t('providerNone') }, ...providers.map(provider => ({ id: provider.id, label: provider.name }))]}
                  onSelect={(id) => { setProviderOpen(false); update({ providerId: id === 'none' ? '' : id }) }} />
              </div>
              <label className={css.field}>{t('healthUrl')}<Input value={draft.healthUrl} onChange={event => update({ healthUrl: event.target.value })} aria-invalid={errors.healthUrl === true} /></label>
              {errors.healthUrl && <span className={css.fieldError}>{t('urlError')}</span>}
            </div>
          </DisclosureRow>

          <DisclosureRow icon={<IconQuestionOutlineMedium aria-hidden="true" />} title={t('help')} open={help} expandable expandOnRowClick
            onToggle={() => { setHelp(open => !open) }}>
            <div className={css.disclosure}><p className={css.muted}>{t('helpDefault')}</p><p className={css.muted}>{t('helpSystem')}</p><p className={css.muted}>{t('helpLimits')}</p><p className={css.muted}>{t('helpTests')}</p>
              <Button size="sm" variant="ghost" icon={<LinkIconMedium kind="url" />} onClick={() => { void shell.openExternal(HELP_URL) }}>{t('docs')}</Button></div>
          </DisclosureRow>

          <Modal open={storagePrompt} onClose={() => { setStoragePrompt(false) }} title={t('storageTitle')} closeLabel={t('cancel')}
            description={t('storageWarning')}
            footer={(
              <>
                <Button variant="outline" onClick={() => { setStoragePrompt(false) }}>{t('cancel')}</Button>
                <Button variant="primary" onClick={() => { setStoragePrompt(false); void save(true) }}>{t('discardPassword')}</Button>
              </>
            )} />
          <Modal open={restorePrompt} onClose={() => { setRestorePrompt(false) }} title={t('restore')} closeLabel={t('cancel')}
            description={t('restoreConfirm')}
            footer={(
              <>
                <Button variant="outline" onClick={() => { setRestorePrompt(false) }}>{t('cancel')}</Button>
                <Button variant="primary" onClick={() => { void restore() }}>{t('restore')}</Button>
              </>
            )} />
          {notice !== undefined && <Toast text={notice} onDone={() => { setNotice(undefined) }} />}
          <div className={css.footerActions}>
            <Button variant="outline" onClick={() => { setRestorePrompt(true) }} disabled={saving}>{t('restore')}</Button>
          </div>
        </div></SettingsForm>
      {runtimeSettings !== undefined && <RuntimeSettings {...runtimeSettings} />}

    </section>
  )
}
