/** Official Plugins page items and the Desktop Capabilities component roster. */

/** npm name of the Desktop Capabilities composition package. */
export const DESKTOP_CAPABILITIES_PACKAGE = '@dsh-electron/dsh-electron-desktop-capabilities'

/** Internal feature whose Components row uses a composition subpath specifier. */
export type CapabilitiesFeatureId = 'directory-picker' | 'brand' | 'network-settings'

/**
 * Display specifier for one internal Capabilities feature.
 * This is the Components-row package name, not a Loader module.
 * @param feature - feature directory and Cordis plugin `name`.
 * @returns `@dsh-electron/dsh-electron-desktop-capabilities/<feature>`.
 */
export function capabilitiesFeatureModuleName(feature: CapabilitiesFeatureId): string {
  return `${DESKTOP_CAPABILITIES_PACKAGE}/${feature}`
}

/** One Official card this feature registers on the Plugins page. */
export interface OfficialRootItem {
  /** `plugins.item` registration id. */
  id: 'desktop-capabilities' | 'theme-studio'
  /** Plugins page order among official items. */
  order: number
  /** Locale key for the card title. */
  labelKey: 'capabilities' | 'themeStudio'
}

/** Where one product component's live phase is read. */
export type CapabilitiesComponentSource =
  | { readonly kind: 'inventory'; readonly moduleName: string }
  | { readonly kind: 'fiber'; readonly fiberName: string }

/** One product component listed on the Desktop Capabilities detail page. */
export interface CapabilitiesComponent {
  /** Stable product id for the roster row. */
  id: string
  /** Locale key for the row label. */
  labelKey: CapabilitiesComponentLabelKey
  /** Live-state source: Host inventory row or Client feature fiber. */
  source: CapabilitiesComponentSource
  /**
   * Package specifier shown on the row.
   * Internal features use `capabilitiesFeatureModuleName`; independent Loader packages use their npm name.
   */
  moduleName: string
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
 * Product roster shown under Desktop Capabilities. Rows cannot be switched;
 * displayed phase comes from Host `pluginInventory/list` or the Client fiber.
 */
export const CAPABILITIES_COMPONENTS: readonly CapabilitiesComponent[] = [
  {
    id: 'network-subprocess',
    labelKey: 'networkSubprocess',
    source: { kind: 'inventory', moduleName: '@dsh-electron/dsh-electron-network-subprocess' },
    moduleName: '@dsh-electron/dsh-electron-network-subprocess',
  },
  {
    id: 'directory-picker-backend',
    labelKey: 'directoryPickerBackend',
    source: { kind: 'inventory', moduleName: '@deepseek-ai/dsh-host-directory-picker-browse' },
    moduleName: '@deepseek-ai/dsh-host-directory-picker-browse',
  },
  {
    id: 'directory-picker',
    labelKey: 'directoryPicker',
    source: { kind: 'fiber', fiberName: 'directory-picker' },
    moduleName: capabilitiesFeatureModuleName('directory-picker'),
  },
  {
    id: 'brand',
    labelKey: 'brand',
    source: { kind: 'fiber', fiberName: 'brand' },
    moduleName: capabilitiesFeatureModuleName('brand'),
  },
  {
    id: 'network-settings',
    labelKey: 'networkSettings',
    source: { kind: 'fiber', fiberName: 'network-settings' },
    moduleName: capabilitiesFeatureModuleName('network-settings'),
  },
]
