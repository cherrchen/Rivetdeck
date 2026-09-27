/** Desktop-required Host overlay inserts shown as official Plugins page items. */

/** One required Desktop package listed on the Plugins page. */
export interface DesktopRequiredPlugin {
  /** Overlay insert id, reused as the `plugins.item` registration id. */
  id: string
  /** npm package name the overlay insert mounts. */
  name: string
  /** Plugins page order among official items. */
  order: number
  /** Locale key for the card title. */
  labelKey: DesktopPluginLabelKey
}

/** Locale keys that name one required Desktop plugin. */
export type DesktopPluginLabelKey =
  | 'networkSubprocess'
  | 'directoryPickerBrowse'
  | 'capabilities'
  | 'themeStudio'
  | 'directoryPicker'
  | 'brand'
  | 'networkSettings'
  | 'desktopPlugins'

/**
 * Required overlay inserts, excluding ecosystem bundles such as Git.
 * The Host patch insert names must stay equal to this list.
 */
export const REQUIRED_DESKTOP_PLUGINS: readonly DesktopRequiredPlugin[] = [
  { id: 'desktop-network-subprocess', name: '@dsh-electron/dsh-electron-network-subprocess', order: 100, labelKey: 'networkSubprocess' },
  { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse', order: 110, labelKey: 'directoryPickerBrowse' },
  { id: 'desktop-capabilities', name: '@dsh-electron/dsh-electron-desktop-capabilities', order: 120, labelKey: 'capabilities' },
  { id: 'theme-studio', name: '@dsh-electron/dsh-theme-studio', order: 130, labelKey: 'themeStudio' },
  { id: 'desktop-directory-picker', name: '@dsh-electron/dsh-electron-ui-directory-picker', order: 140, labelKey: 'directoryPicker' },
  { id: 'desktop-ui-brand', name: '@dsh-electron/dsh-electron-ui-brand', order: 150, labelKey: 'brand' },
  { id: 'desktop-ui-network-settings', name: '@dsh-electron/dsh-electron-ui-network-settings', order: 160, labelKey: 'networkSettings' },
  { id: 'desktop-ui-plugins', name: '@dsh-electron/dsh-electron-ui-desktop-plugins', order: 170, labelKey: 'desktopPlugins' },
]
