import type { BrowserWindow } from 'electron'
import { app, BrowserWindow as ElectronBrowserWindow, nativeImage, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isAllowedExternalUrl,
  resolveHomepageUrl,
  resolveProjectUrl,
} from './desktop/index.ts'
import {
  formatDesktopMessage,
  resolveDesktopMainLocale,
  type DesktopMainLocale,
  type DesktopMainMessages,
} from './locale.ts'
import { readDesktopManifest } from './manifest.ts'

let aboutWindow: BrowserWindow | undefined

/** Open or focus the desktop-owned about window. */
export async function showAboutWindow(parent: BrowserWindow | undefined): Promise<void> {
  if (aboutWindow !== undefined && !aboutWindow.isDestroyed()) {
    aboutWindow.show()
    aboutWindow.focus()
    return
  }
  const locale = resolveDesktopMainLocale(app.getLocale())
  const messages = locale.messages
  const manifest = readDesktopManifest(app.getAppPath())
  const projectUrl = resolveProjectUrl(manifest)
  const websiteUrl = resolveHomepageUrl(manifest)
  const revision = resolveAboutRevision(app.getAppPath())
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'))
  const windowTitle = formatDesktopMessage(messages.aboutWindowTitle, { name: app.name })
  const commitUrl = aboutCommitUrl(projectUrl, revision.commit)
  const externalUrls = [projectUrl, websiteUrl, commitUrl].filter((url): url is string => url !== undefined)
  const allowedExternal = new Set(externalUrls.flatMap((url) => {
    const normalized = normalizeAboutExternalUrl(url)
    return normalized === undefined ? [] : [normalized]
  }))
  aboutWindow = new ElectronBrowserWindow({
    width: 340,
    height: 520,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    ...(parent === undefined ? {} : { parent }),
    show: false,
    title: windowTitle,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const window = aboutWindow
  window.once('closed', () => { aboutWindow = undefined })
  window.once('ready-to-show', () => { window.show() })
  const openExternal = (url: string): void => {
    const normalized = normalizeAboutExternalUrl(url)
    if (normalized === undefined || !allowedExternal.has(normalized)) return
    if (!isAllowedExternalUrl(normalized)) return
    void shell.openExternal(normalized)
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternal(url)
  })
  await window.loadURL(aboutDocument({
    applicationName: app.name,
    build: revision.build,
    commit: revision.commit,
    commitUrl,
    iconDataUrl: icon.isEmpty() ? undefined : icon.toDataURL(),
    localeId: locale.id,
    messages,
    projectUrl,
    version: app.getVersion(),
    websiteUrl,
  }))
}

/** Optional build and commit identity shown in the About metadata rows. */
export interface AboutRevision {
  build: string | undefined
  commit: string | undefined
}

/**
 * Resolve packaged About revision fields.
 * Packaged builds read `build-info.json` next to the Electron package manifest.
 * Missing Build or Commit stay undefined so the About rows render empty.
 * @param appPath - Electron application root that may contain `build-info.json`.
 * @param env - Process environment used when the packaged file is absent.
 */
export function resolveAboutRevision(
  appPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): AboutRevision {
  const fromFile = appPath === undefined ? {} : readBuildInfoFile(appPath)
  return {
    build: nonEmpty(fromFile.build) ?? nonEmpty(env.RIVETDECK_BUILD),
    commit: nonEmpty(fromFile.commit) ?? nonEmpty(env.RIVETDECK_COMMIT) ?? shortCommit(env.GITHUB_SHA),
  }
}

function readBuildInfoFile(appPath: string): { build?: string; commit?: string } {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(appPath, 'build-info.json'), 'utf8'))
    if (!isRecord(raw)) return {}
    return {
      ...typeof raw.build === 'string' ? { build: raw.build } : {},
      ...typeof raw.commit === 'string' ? { commit: raw.commit } : {},
    }
  } catch (error) {
    // Absent or invalid build-info.json leaves About Build/Commit empty.
    void error
    return {}
  }
}

function shortCommit(value: string | undefined): string | undefined {
  const trimmed = nonEmpty(value)
  return trimmed === undefined ? undefined : trimmed.slice(0, 9)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Commit browse URL when both the project page and commit hash are known. */
export function aboutCommitUrl(
  projectUrl: string | undefined,
  commit: string | undefined,
): string | undefined {
  if (projectUrl === undefined || commit === undefined) return undefined
  return `${projectUrl}/commit/${encodeURIComponent(commit)}`
}

interface AboutDocumentOptions {
  applicationName: string
  build: string | undefined
  commit: string | undefined
  commitUrl: string | undefined
  iconDataUrl: string | undefined
  localeId: DesktopMainLocale['id']
  messages: DesktopMainMessages
  projectUrl: string | undefined
  version: string
  websiteUrl: string | undefined
}

/**
 * Build the sandboxed About document.
 * Layout mirrors Ghostty's About window; colors use system UI tokens.
 */
export function aboutDocument(options: AboutDocumentOptions): string {
  const { messages } = options
  const icon = options.iconDataUrl === undefined
    ? '<div class="icon iconFallback" aria-hidden="true">R</div>'
    : `<img class="icon" src="${escapeAttribute(options.iconDataUrl)}" alt="">`
  const actionLinks = [
    ...(options.projectUrl === undefined
      ? []
      : [`<a class="action" href="${escapeAttribute(options.projectUrl)}" target="_blank" rel="noreferrer">${escapeHtml(messages.aboutGitHub)}</a>`]),
    ...(options.websiteUrl === undefined
      ? []
      : [`<a class="action" href="${escapeAttribute(options.websiteUrl)}" target="_blank" rel="noreferrer">${escapeHtml(messages.aboutHomepage)}</a>`]),
  ]
  const actions = actionLinks.length === 0 ? '' : `<div class="actions">${actionLinks.join('')}</div>`
  const commitValue = options.commit === undefined
    ? ''
    : options.commitUrl === undefined
      ? escapeHtml(options.commit)
      : `<a class="commit" href="${escapeAttribute(options.commitUrl)}" target="_blank" rel="noreferrer">${escapeHtml(options.commit)}</a>`
  const title = formatDesktopMessage(messages.aboutWindowTitle, { name: options.applicationName })
  const html = `<!doctype html>
<html lang="${options.localeId}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>
:root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  overflow: hidden;
  color: CanvasText;
  background: Canvas;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: drag;
}
main {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 36px 36px 40px;
  text-align: center;
  user-select: text;
}
.icon {
  width: 128px;
  height: 128px;
  margin-bottom: 22px;
  border-radius: 22.5%;
  filter: drop-shadow(0 10px 18px color-mix(in srgb, CanvasText 18%, transparent));
}
.iconFallback {
  display: grid;
  place-items: center;
  background: AccentColor;
  color: AccentColorText;
  font-size: 42px;
  font-weight: 650;
}
h1 {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.15;
}
.tagline {
  max-width: 250px;
  margin: 10px 0 0;
  color: color-mix(in srgb, CanvasText 62%, Canvas);
  font-size: 13px;
  font-weight: 400;
  line-height: 1.45;
}
.meta {
  display: grid;
  grid-template-columns: max-content max-content;
  column-gap: 10px;
  row-gap: 5px;
  margin: 22px 0 0;
  font-size: 12px;
  line-height: 1.35;
  min-height: calc(3 * 1.35em + 2 * 5px);
}
.meta dt {
  margin: 0;
  text-align: right;
  color: color-mix(in srgb, CanvasText 55%, Canvas);
  font-weight: 500;
}
.meta dd {
  margin: 0;
  min-height: 1.35em;
  text-align: left;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
.meta a.commit {
  color: LinkText;
  text-decoration: none;
  -webkit-app-region: no-drag;
}
.meta a.commit:hover { text-decoration: underline; text-underline-offset: 2px; }
.meta a.commit:focus-visible {
  outline: 2px solid AccentColor;
  outline-offset: 2px;
  border-radius: 2px;
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 28px;
  -webkit-app-region: no-drag;
}
.action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 92px;
  height: 28px;
  padding: 0 14px;
  border-radius: 8px;
  background: color-mix(in srgb, CanvasText 10%, Canvas);
  color: CanvasText;
  font-size: 12px;
  font-weight: 500;
  text-decoration: none;
}
.action:hover {
  background: color-mix(in srgb, CanvasText 16%, Canvas);
}
.action:focus-visible {
  outline: 2px solid AccentColor;
  outline-offset: 2px;
}
</style></head><body><main>${icon}<h1>${escapeHtml(options.applicationName)}</h1><p class="tagline">${escapeHtml(messages.aboutBody)}</p><dl class="meta"><dt>${escapeHtml(messages.aboutVersionLabel)}</dt><dd>${escapeHtml(options.version)}</dd><dt>${escapeHtml(messages.aboutBuildLabel)}</dt><dd>${escapeHtml(options.build ?? '')}</dd><dt>${escapeHtml(messages.aboutCommitLabel)}</dt><dd>${commitValue}</dd></dl>${actions}</main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** Normalize About action URLs so trailing-slash variants still open externally. */
export function normalizeAboutExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return url.href.replace(/\/$/, '')
  } catch {
    return undefined
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
