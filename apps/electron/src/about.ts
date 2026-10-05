import type { BrowserWindow } from 'electron'
import { app, BrowserWindow as ElectronBrowserWindow, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import {
  desktopWindowChrome,
  isAllowedExternalUrl,
  resolveProjectUrl,
} from './desktop/index.ts'
import { readDesktopManifest } from './manifest.ts'

let aboutWindow: BrowserWindow | undefined

/** Open or focus the desktop-owned about window. */
export async function showAboutWindow(parent: BrowserWindow | undefined): Promise<void> {
  if (aboutWindow !== undefined && !aboutWindow.isDestroyed()) {
    aboutWindow.show()
    aboutWindow.focus()
    return
  }
  const manifest = readDesktopManifest(app.getAppPath())
  const projectUrl = resolveProjectUrl(manifest)
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'))
  aboutWindow = new ElectronBrowserWindow({
    ...desktopWindowChrome(process.platform),
    width: 440,
    height: 520,
    minWidth: 400,
    minHeight: 480,
    maximizable: false,
    fullscreenable: false,
    resizable: false,
    ...(parent === undefined ? {} : { parent }),
    show: false,
    title: `About ${app.name}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const window = aboutWindow
  window.once('closed', () => { aboutWindow = undefined })
  window.once('ready-to-show', () => { window.show() })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === projectUrl && isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  await window.loadURL(aboutDocument({
    applicationName: app.name,
    iconDataUrl: icon.isEmpty() ? undefined : icon.toDataURL(),
    projectUrl,
    version: app.getVersion(),
  }))
}

interface AboutDocumentOptions {
  applicationName: string
  iconDataUrl: string | undefined
  projectUrl: string | undefined
  version: string
}

/** Build the self-contained about document loaded into its sandboxed window. */
export function aboutDocument(options: AboutDocumentOptions): string {
  const icon = options.iconDataUrl === undefined
    ? '<div class="icon iconFallback" aria-hidden="true">R</div>'
    : `<img class="icon" src="${escapeAttribute(options.iconDataUrl)}" alt="">`
  const project = options.projectUrl === undefined
    ? ''
    : `<a href="${escapeAttribute(options.projectUrl)}" target="_blank" rel="noreferrer">GitHub repository</a>`
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>About ${escapeHtml(options.applicationName)}</title><style>
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; overflow: hidden; color: light-dark(#171a21, #eff2f7); background: light-dark(#f7f8fb, #171a21); }
.titlebar { height: 40px; display: grid; place-items: center; color: light-dark(#747c8c, #a3aabb); border-bottom: 1px solid light-dark(#e5e8ef, #2b303b); font-size: 12px; font-weight: 500; user-select: none; -webkit-app-region: drag; }
main { min-height: calc(100vh - 40px); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 52px 50px; text-align: center; }
.icon { width: 112px; height: 112px; margin-bottom: 26px; border-radius: 25%; filter: drop-shadow(0 16px 30px rgb(20 36 70 / 16%)); }
.iconFallback { display: grid; place-items: center; background: #3964fe; color: white; font-size: 30px; font-weight: 650; }
h1 { margin: 0; font-size: 25px; line-height: 1.2; letter-spacing: -0.025em; }
.version { margin: 10px 0 0; color: light-dark(#6e7584, #a3aabb); font: 500 12px/1.4 ui-monospace, "SF Mono", Consolas, monospace; }
.rule { width: 32px; height: 2px; margin: 24px 0; border-radius: 2px; background: #3964fe; }
p { max-width: 300px; margin: 0; color: light-dark(#555d6c, #b9bfca); font-size: 13px; line-height: 1.65; }
a { margin-top: 20px; color: light-dark(#2455e6, #86a3ff); font-size: 13px; text-underline-offset: 3px; -webkit-app-region: no-drag; }
a:focus-visible { outline: 2px solid #3964fe; outline-offset: 4px; border-radius: 2px; }
</style></head><body><div class="titlebar">About</div><main>${icon}<h1>${escapeHtml(options.applicationName)}</h1><div class="version">Version ${escapeHtml(options.version)}</div><div class="rule"></div><p>Desktop application built on DeepSeek Harness with its local Web interface.</p>${project}</main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
