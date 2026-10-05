/**
 * Upstream AppFrame sets `document.title` from `DSH_CLIENT_TITLE`, falling back
 * to the localized `brand.localBuild` string when that build-time value is absent.
 * Electron's packaged client artifacts are ordinary local builds, so the window
 * and Dock inherit "DSH Local Build" / "DSH 本地构建" unless Main rewrites them.
 */
const UPSTREAM_LOCAL_BUILD_TITLES = ['DSH Local Build', 'DSH 本地构建'] as const

/**
 * Rewrite an upstream page title so the product segment uses the Desktop product name.
 * @param pageTitle - Title emitted by the renderer (`DocumentTitle` / AppFrame).
 * @param productName - Desktop `productName` / `app.name` (Rivetdeck).
 * @returns Title safe to apply with `BrowserWindow.setTitle`.
 */
export function desktopWindowTitle(pageTitle: string, productName: string): string {
  for (const localBuild of UPSTREAM_LOCAL_BUILD_TITLES) {
    if (pageTitle === localBuild) return productName
    const suffix = ` — ${localBuild}`
    if (pageTitle.endsWith(suffix)) {
      return `${pageTitle.slice(0, -suffix.length)} — ${productName}`
    }
  }
  return pageTitle
}
