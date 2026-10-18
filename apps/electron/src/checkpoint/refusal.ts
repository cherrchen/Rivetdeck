/**
 * Open-time detection (docs/electron/session-checkpoint-restore.md): the
 * bundled Host serializes `SessionFormatUnsupportedError` onto the Remote
 * stream as `{type:'error', error:{code:'gateway/internal', message}}` — the
 * error class does not survive the wire, so this module recognizes the stable
 * refusal text. The id-bearing forms come from `sessionFormatVersionRefusal`
 * (`session "<id>" uses log format …`); event-admission refusals name only the
 * raw log, whose session directory carries the backend-encoded session id.
 * Frames that do not match are ignored; a hit is only ever a prompt hint —
 * the restore transaction itself re-validates before touching live files.
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
const EVENT_REFUSAL = /format v\d+ contains unknown event type/
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
  if (sessionId !== undefined) {
    return { sessionId, ...(dirTail === undefined ? {} : { dirTail }) }
  }
  if (dirTail !== undefined && (EVENT_REFUSAL.test(message) || message.includes('uses log format'))) {
    return { dirTail }
  }
  return undefined
}
