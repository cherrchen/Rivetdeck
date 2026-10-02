/** Chromium download transport owned by the Desktop proxy policy. */
import type { Session } from 'electron'
import type { RuntimeFetch } from './installer.ts'

/** Session operations required by runtime downloads. */
export type RuntimeDownloadSession = Pick<Session, 'fetch'> & {
  webRequest: Pick<Session['webRequest'], 'onBeforeRequest'>
}

/** Guard every redirect before Chromium sends it; Electron manual fetch cancels redirects.
 * @param session Dedicated runtime Session registered with the Desktop proxy applier.
 * @returns Streaming transport that rejects HTTPS downgrades without direct fallback.
 */
export function createRuntimeFetch(session: RuntimeDownloadSession): RuntimeFetch {
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: new URL(details.url).protocol !== 'https:' })
  })
  return async (url, signal) => {
    if (new URL(url).protocol !== 'https:') throw new Error('runtime downloads require HTTPS')
    return await session.fetch(url, { signal, redirect: 'follow' })
  }
}
