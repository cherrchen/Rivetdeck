import type {
  BrowserWindowConstructorOptions,
  ContextMenuParams,
  MenuItemConstructorOptions,
} from 'electron'
import type { DesktopManifest } from '../manifest.ts'

/** Visual height shared by native window controls and the app header row. */
export const NATIVE_CONTROL_ROW_HEIGHT = 40

/** macOS integrated chrome: hidden title bar with native traffic lights. */
function darwinWindowChrome(): Pick<BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'> {
  return {
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 13 },
  }
}

type IntegratedWindowChrome = Pick<BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'>

/** Transparent Window Controls Overlay chrome for Windows and Linux fallback. */
function overlayWindowChrome(): IntegratedWindowChrome {
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#747c8c',
      height: NATIVE_CONTROL_ROW_HEIGHT,
    },
  }
}

/** Window options shared by integrated Desktop chrome windows. */
export function desktopWindowChrome(platform: NodeJS.Platform): IntegratedWindowChrome {
  switch (platform) {
    case 'darwin':
      return darwinWindowChrome()
    case 'win32':
      return overlayWindowChrome()
    default:
      return overlayWindowChrome()
  }
}

/** Whether a Chromium permission request belongs to the local clipboard writer. */
export function allowsClipboardWrite(
  permission: string,
  requestingOrigin: string,
  allowedOrigin: string,
): boolean {
  if (permission !== 'clipboard-sanitized-write') return false
  try {
    return new URL(requestingOrigin).origin === new URL(allowedOrigin).origin
  } catch {
    return false
  }
}

/** Normalize a package URL field into an http(s) href without a trailing slash. */
function normalizeHttpUrl(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined
  const normalized = candidate.replace(/^git\+/, '').replace(/\.git$/, '')
  try {
    const url = new URL(normalized)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href.replace(/\/$/, '') : undefined
  } catch {
    return undefined
  }
}

/** Resolve the public GitHub project page from package repository metadata. */
export function resolveProjectUrl(manifest: DesktopManifest): string | undefined {
  const repository = manifest.repository
  const candidate = typeof repository === 'string'
    ? repository
    : isRecord(repository) && typeof repository.url === 'string'
      ? repository.url
      : undefined
  return normalizeHttpUrl(candidate)
}

/** Resolve the product website from package homepage metadata. */
export function resolveHomepageUrl(manifest: DesktopManifest): string | undefined {
  return normalizeHttpUrl(manifest.homepage)
}

/** Build the native page context menu from Chromium editing capabilities. */
export function contextMenuTemplate(
  params: Pick<ContextMenuParams, 'editFlags' | 'isEditable' | 'selectionText'>,
  development: boolean,
): MenuItemConstructorOptions[] {
  const editing: MenuItemConstructorOptions[] = params.isEditable
    ? [
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ]
    : [
      { role: 'copy', enabled: params.selectionText.length > 0 && params.editFlags.canCopy },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ]
  return [
    ...editing,
    { type: 'separator' },
    { role: 'reload' },
    ...(development ? [{ role: 'toggleDevTools' as const }] : []),
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
