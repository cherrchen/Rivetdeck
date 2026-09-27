/**
 * Renderless directory-flow occupant that drives Electron Main's directory dialog.
 */
import { useEffect, useRef, type ReactElement } from 'react'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Injected pick call bound in apply. */
export interface ElectronFlowInjected {
  /** Ask Electron Main to open its OS directory chooser. */
  pick: () => Promise<string | null>
}

/**
 * @param props - Owner conversation plus injected pick.
 * @returns null — the OS chooser is owned by Electron Main.
 */
export function ElectronDirectoryFlow(
  props: DirectoryFlowOwnerProps & ElectronFlowInjected,
): ReactElement | null {
  const { open, pick } = props
  const armed = useRef(false)
  const outcome = useRef(props)
  outcome.current = props
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    if (!open) {
      armed.current = false
      return
    }
    if (armed.current) return
    armed.current = true
    pick().then(
      (path) => {
        if (!alive.current) return
        if (path === null) outcome.current.onCancel()
        else outcome.current.onPicked(path)
      },
      (reason: unknown) => {
        if (!alive.current) return
        outcome.current.onError(reason instanceof Error ? reason.message : String(reason))
      },
    )
  }, [open, pick])
  return null
}
