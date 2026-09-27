/** Official Plugins page items and the Desktop Capabilities component roster. */

/** One Official card this feature registers on the Plugins page. */
export interface OfficialRootItem {
  /** `plugins.item` registration id. */
  id: 'desktop-capabilities' | 'theme-studio'
  /** Plugins page order among official items. */
  order: number
  /** Locale key for the card title. */
  labelKey: 'capabilities' | 'themeStudio'
}

/** One product component listed on the Desktop Capabilities detail page. */
export interface CapabilitiesComponent {
  /** Stable product id for the roster row. */
  id: string
  /** Locale key for the row label. */
  labelKey: CapabilitiesComponentLabelKey
  /** npm package name when the row is an independent Loader package. */
  moduleName?: string
}

/** Locale keys that name one Capabilities component. */
export type CapabilitiesComponentLabelKey =
  | 'networkSubprocess'
  | 'directoryPickerBackend'
  | 'directoryPicker'
  | 'brand'
  | 'networkSettings'

/**
 * Official items this feature adds. Upstream official items stay on the page.
 */
export const OFFICIAL_ROOT_ITEMS: readonly OfficialRootItem[] = [
  { id: 'desktop-capabilities', order: 120, labelKey: 'capabilities' },
  { id: 'theme-studio', order: 130, labelKey: 'themeStudio' },
]

/**
 * Product roster shown under Desktop Capabilities. Not a live Loader inventory.
 */
export const CAPABILITIES_COMPONENTS: readonly CapabilitiesComponent[] = [
  {
    id: 'network-subprocess',
    labelKey: 'networkSubprocess',
    moduleName: '@dsh-electron/dsh-electron-network-subprocess',
  },
  {
    id: 'directory-picker-backend',
    labelKey: 'directoryPickerBackend',
    moduleName: '@deepseek-ai/dsh-host-directory-picker-browse',
  },
  { id: 'directory-picker', labelKey: 'directoryPicker' },
  { id: 'brand', labelKey: 'brand' },
  { id: 'network-settings', labelKey: 'networkSettings' },
]
