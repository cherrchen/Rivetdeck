/**
 * Open-time detection (docs/electron/session-checkpoint-restore.md): the
 * bundled Host serializes `SessionFormatUnsupportedError` onto the Remote
 * stream as `{type:'error', error:{code:'gateway/internal', message}}` — the
 * error class does not survive the wire, so this module recognizes the stable
 * refusal text. Both upstream forms name `session "<id>"` verbatim:
 * `sessionFormatVersionRefusal` emits `session "<id>" uses log format vN, but
 * this harness reads only vN: …` (errors.ts), and event admission emits
 * `session "<id>" contains event type "…" (seq N) unknown to this harness and
 * not marked ignorable; refusing to interpret the log` — the retired
 * `request/header` "fallback" shape follows the same `contains … (seq N) …
 * refusing to interpret the log` pattern (storage-contract.ts). The `raw log:`
 * suffix supplies the backend-encoded session directory as fallback
 * attribution. Frames that do not match are ignored; a hit is only ever a
 * prompt hint — the restore transaction itself re-validates before touching
 * live files.
 */

import { basename, dirname } from 'node:path'

/** A session-format refusal lifted from one Remote stream error frame. */
export interface SessionRefusalHit {
  /** Raw session id when the message carried `session "<id>"`. */
  readonly sessionId?: string
  /** Backend-encoded directory tail from the `raw log:` path. */
  readonly dirTail?: string
}

const SESSION_VERSION_REFUSAL = /session "([^"]+)" uses log format v\d+, but this harness reads only v\d+/
// Both event-admission refusals — unknown required type and the retired
// request/header "fallback" shape — share the `contains … (seq N) … refusing
// to interpret the log` skeleton.
const EVENT_REFUSAL = /session "([^"]+)" contains .+ \(seq \d+\) .+refusing to interpret the log/
const RAW_LOG_SUFFIX = /\(raw log: (.+)\)\s*$/

/**
 * Recognize a session-format refusal in one Host→renderer frame.
 * @param data - Raw WebSocket text of one `/api/remote.mux` server message.
 * @returns Session attribution, or undefined for unrelated traffic.
 */
export function detectFormatRefusalFrame(data: string): SessionRefusalHit | undefined {
  if (!data.includes('"type":"error"')) return undefined
  if (!data.includes('raw log:') && !data.includes('uses log format')) return undefined
  let frame: unknown
  try {
    frame = JSON.parse(data)
  } catch {
    return undefined
  }
  if (typeof frame !== 'object' || frame === null) return undefined
  const error = (frame as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return undefined
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return undefined

  const rawLog = RAW_LOG_SUFFIX.exec(message)?.[1]
  const dirTail = rawLog === undefined ? undefined : basename(dirname(rawLog))
  const sessionId = SESSION_VERSION_REFUSAL.exec(message)?.[1]
    ?? EVENT_REFUSAL.exec(message)?.[1]
  if (sessionId !== undefined) {
    return { sessionId, ...(dirTail === undefined ? {} : { dirTail }) }
  }
  if (dirTail !== undefined && message.includes('uses log format')) {
    return { dirTail }
  }
  return undefined
}
