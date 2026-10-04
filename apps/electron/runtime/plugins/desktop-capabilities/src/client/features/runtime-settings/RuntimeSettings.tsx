/** Runtime views observe Main state; local state holds only selection and dialog visibility. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RuntimeCapability, RuntimeName, RuntimeSnapshot, RuntimeState } from '../../../../../../../src/toolchains/domain.ts'
import css from './RuntimeSettings.module.css'

/** Runtime and restart capabilities injected through the Desktop provider. */
export interface RuntimeSettingsInjected { runtimes: RuntimeCapability; restart: () => Promise<void> }
type Common = PropsLocale<'settings.runtimesElectron'> & InjectFace<RuntimeSettingsInjected>
type Translator = Common['t']
const NAMES = ['node', 'python'] as const
const busy = (state: RuntimeState) => ['downloading', 'verifying', 'installing'].includes(state.phase)
const ignoreImplicitDismiss = (): void => {}

/** Keep the setup close control out of the modal focus trap. */
function ConcealSetupClose() {
  useLayoutEffect(() => {
    const button = document.querySelector(`.${css.setupDialog ?? ''} h2 + button`)
    if (!(button instanceof HTMLButtonElement)) return
    // The trap's entry selector matches every enabled button, including one hidden with CSS.
    button.disabled = true
    button.hidden = true
  })
  return null
}

function useRuntimes(runtimes: RuntimeCapability) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>()
  const [error, setError] = useState(false)
  const [required, setRequired] = useState<boolean>()
  useEffect(() => {
    let live = true
    const receive = (state: RuntimeSnapshot) => {
      if (!live) return
      setSnapshot(state)
      setRequired(previous => previous ?? !state.onboardingCompleted)
    }
    // The subscription sends the authoritative current value, avoiding stale query/subscribe races.
    const dispose = runtimes.subscribe(receive)
    void runtimes.getState().catch(() => { if (live) setError(true) })
    return () => { live = false; dispose() }
  }, [runtimes])
  return { snapshot, error, required }
}

function RuntimeRow({ state, runtimes, t, actionError, allowInstall = true }: {
  state: RuntimeState
  runtimes: RuntimeCapability
  t: Translator
  actionError: () => void
  allowInstall?: boolean
}) {
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  const invoke = (action: 'install' | 'cancel' | 'remove') => { void runtimes[action](state.name).catch(actionError) }
  return <article className={css.row} aria-label={t(state.name)}>
    <div className={css.rowText}><h3>{t(state.name)} · {state.installedVersion ?? state.version}</h3>
      <p>{t(state.name === 'node' ? 'nodeHint' : 'pythonHint')}</p>
      <p role="status">{t(state.phase)}</p>
      {state.phase === 'downloading' && <progress aria-label={t('downloading')} value={state.total === undefined ? undefined : state.received} max={state.total} />}
      {state.error !== undefined && <p role="alert">{t(`${state.error}Error`)}</p>}
      {state.location !== undefined && <><p>{t('managed')}</p><code className={css.path}>{state.location}</code></>}
    </div><div className={css.actions}>
      {busy(state) ? <Button size="sm" variant="outline" onClick={() => invoke('cancel')}>{t('cancel')}</Button>
        : allowInstall && state.phase !== 'removing' && <>
          <Button size="sm" variant="outline" onClick={() => invoke('install')}>{t(state.phase === 'update-available' ? 'update' : state.phase === 'failed' ? 'retry' : state.phase === 'installed' ? 'reinstall' : 'install')}</Button>
          {state.location !== undefined && <Button size="sm" variant="outline" onClick={() => setConfirmRemoval(true)}>{t('remove')}</Button>}
        </>}
    </div>
    <Modal open={confirmRemoval} title={t('removeTitle')} description={t('removeHint')} closeLabel={t('close')}
      onClose={() => setConfirmRemoval(false)} footer={<>
        <Button size="sm" variant="outline" onClick={() => setConfirmRemoval(false)}>{t('keep')}</Button>
        <Button size="sm" onClick={() => { setConfirmRemoval(false); invoke('remove') }}>{t('confirmRemove')}</Button>
      </>} />
  </article>
}

/** Settings section with independent actions and shared Main progress. */
export function RuntimeSettings({ runtimes, restart, t }: Common) {
  const { snapshot, error } = useRuntimes(runtimes)
  const [actionError, setActionError] = useState(false)
  return <section className={css.section} aria-label={t('title')}>
    <h3 className={css.heading}>{t('title')}</h3><p className={css.intro}>{t('intro')}</p>
    {(error || actionError) && <p role="alert">{t(error ? 'loadError' : 'operationError')}</p>}
    {snapshot !== undefined && NAMES.map(name => (
      <RuntimeRow key={name} state={snapshot[name]} runtimes={runtimes} t={t} actionError={() => setActionError(true)} />
    ))}
    {snapshot !== undefined && NAMES.some(name => snapshot[name].restartRequired) && <>
      <p>{t('restartHint')}</p><Button onClick={() => { void restart().catch(() => setActionError(true)) }}>{t('restart')}</Button>
    </>}
  </section>
}

/** First-profile optional consent dialog mounted after the Core Host and client shell are ready.
 * Install and Skip persist completion and then call `complete()`. Install starts each selected
 * download without waiting for it. The mask, Escape, and close control do not persist completion
 * or call `complete()`.
 */
export function RuntimeSetup({ runtimes, t, complete }: Common & PropsRuntime<'settings.onboarding'>) {
  const { snapshot, required } = useRuntimes(runtimes)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => { if (required === false) complete() }, [required, complete])
  const [selected, setSelected] = useState<Record<RuntimeName, boolean>>({ node: false, python: false })
  const [error, setError] = useState(false)
  const [settling, setSettling] = useState(false)
  const settlement = useRef(false)
  const settle = (installSelected: boolean) => {
    if (settlement.current) return
    settlement.current = true
    setSettling(true)
    void (async () => {
      try {
        await runtimes.completeOnboarding()
      } catch (persistError) {
        console.error('desktop runtime onboarding persistence failed', persistError)
        settlement.current = false
        setSettling(false)
        setError(true)
        return
      }
      if (installSelected) {
        for (const name of NAMES) {
          if (!selected[name]) continue
          void runtimes.install(name).catch((installError: unknown) => {
            console.error(`desktop ${name} runtime installation failed`, installError)
          })
        }
      }
      setDismissed(true)
      complete()
    })()
  }
  if (snapshot === undefined || !required || dismissed) return null
  return <Modal open className={css.setupDialog!} title={t('setup')} closeLabel={t('close')}
    onClose={ignoreImplicitDismiss} description={t('intro')}
    footer={<><Button size="sm" variant="outline" disabled={settling} onClick={() => { settle(false) }}>{t('skip')}</Button>
      <Button disabled={settling || !NAMES.some(name => selected[name]) || NAMES.some(name => busy(snapshot[name]))}
        onClick={() => { settle(true) }}>{t('selected')}</Button></>}>
    <div className={css.section}>
      <ConcealSetupClose />
      {error && <p role="alert">{t('operationError')}</p>}
      {NAMES.map(name => <div key={name}>
        <div className={css.choice}><span>{t(name)} · {snapshot[name].version}</span>
          <Switch checked={selected[name]} label={t(name)} onChange={checked => setSelected({ ...selected, [name]: checked })} />
        </div>
        <RuntimeRow allowInstall={snapshot.onboardingCompleted} state={snapshot[name]}
          runtimes={runtimes} t={t} actionError={() => setError(true)} />
      </div>)}
    </div>
  </Modal>
}
