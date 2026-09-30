/**
 * Parse the Host-injected index HTML into the Electron renderer bootstrap payload.
 */

import type { HostBootstrap } from './bridge-types.ts'

/** Marker rendered by Host `renderIndexInjections` for `kind: 'global'` rows. */
const BOOT_MARKER = 'globalThis["__DSH_BOOT__"] = '
const PRELOAD_SCRIPT = /<script\s+src="([^"]+)"\s*>\s*<\/script>/g

/**
 * Extract `__DSH_BOOT__` and classic preload script URLs from Host index HTML.
 * @param html - Response body from `GET <harness>/`.
 * @returns Structured bootstrap for the desktop renderer.
 */
export function extractHostBootstrap(html: string): HostBootstrap {
  const bootAt = html.indexOf(BOOT_MARKER)
  if (bootAt === -1) {
    throw new Error('desktop bootstrap: globalThis["__DSH_BOOT__"] assignment missing from Host index HTML')
  }
  const jsonStart = bootAt + BOOT_MARKER.length
  const boot = parseJsonValue(html, jsonStart)

  const preloadUrls: string[] = []
  for (const match of html.matchAll(PRELOAD_SCRIPT)) {
    const url = match[1]
    if (url === undefined) continue
    const pluginUrl = pluginPreloadUrl(decodeHtmlAttribute(url))
    if (pluginUrl !== undefined) preloadUrls.push(pluginUrl)
  }
  if (preloadUrls.length === 0) {
    throw new Error('desktop bootstrap: Host index HTML contains no /plugins/ preload scripts')
  }

  return { boot, preloadUrls }
}

/**
 * Normalize a Host plugin script URL to an absolute `/plugins/` path.
 * Served boot rows are document-relative (`plugins/...`); older HTML used `/plugins/...`.
 * @param src - Decoded `script src` attribute.
 * @returns Absolute plugin path, or undefined when the script is not a plugin preload.
 */
function pluginPreloadUrl(src: string): string | undefined {
  if (src.startsWith('/plugins/')) return src
  if (src.startsWith('plugins/')) return `/${src}`
  return undefined
}

/** Decode the fixed entity set used by the Host's quoted attribute renderer. */
function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

/**
 * Parse one JSON value starting at `start`, allowing the Host's `\u003c` escapes.
 * @param source - Full HTML document.
 * @param start - Index of the first JSON character.
 * @returns Parsed JSON value.
 */
function parseJsonValue(source: string, start: number): unknown {
  const slice = source.slice(start)
  const end = slice.indexOf('</script>')
  if (end === -1) {
    throw new Error('desktop bootstrap: could not locate end of globalThis["__DSH_BOOT__"] JSON')
  }
  try {
    return JSON.parse(slice.slice(0, end).trim().replace(/;?\s*$/, ''))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`desktop bootstrap: invalid globalThis["__DSH_BOOT__"] JSON (${message})`)
  }
}
