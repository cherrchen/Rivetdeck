/**
 * Compatibility shim: route `navigator.clipboard` text APIs through Main.
 * Upstream UI calls `navigator.clipboard` with no injection seam; this adapter
 * is removable once a package-level clipboard seam exists.
 */

/** Install the desktop clipboard shim on `navigator.clipboard`. */
export function installDesktopClipboardShim(): void {
  const bridge = window.deepseekDesktop
  if (bridge === undefined) {
    throw new Error('desktop clipboard shim: window.deepseekDesktop is missing')
  }

  const desktopClipboard = {
    readText: () => bridge.clipboard.readText(),
    writeText: (text: string) => bridge.clipboard.writeText(text),
  }

  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      enumerable: true,
      get: () => desktopClipboard,
    })
  } catch {
    // Some Chromium builds expose a non-configurable clipboard; fall back.
    const target = navigator.clipboard
    target.readText = desktopClipboard.readText
    target.writeText = desktopClipboard.writeText
  }
}
