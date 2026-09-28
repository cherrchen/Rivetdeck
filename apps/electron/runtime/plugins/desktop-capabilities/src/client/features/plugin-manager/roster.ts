/** Official Plugins page items and the Desktop Capabilities component roster. */

/** npm name of the Desktop Capabilities composition package. */
export const DESKTOP_CAPABILITIES_PACKAGE = '@dsh-electron/dsh-electron-desktop-capabilities'

/** Published version shown on the Desktop Capabilities detail page. */
export const DESKTOP_CAPABILITIES_VERSION = '0.1.0'

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

/** Locale keys for the Official Desktop Capabilities card one-liner. */
export type OfficialDescriptionKey = 'capabilitiesDescription'

/** The one Official card this feature registers on the Plugins page. */
export interface OfficialRootItem {
  /** `plugins.item` registration id. */
  id: 'desktop-capabilities'
  /** Plugins page order among official items. */
  order: number
  /** Locale key for the card title. */
  labelKey: 'capabilities'
  /** Locale key for the card one-liner and the detail description. */
  descriptionKey: OfficialDescriptionKey
  /** Package name under the detail title. */
  packageName: string
  /** Detail-page version tag. */
  version: string
}

/** Where one product component's live phase is read. */
export type CapabilitiesComponentSource =
  | { readonly kind: 'inventory'; readonly moduleName: string }
  | { readonly kind: 'fiber'; readonly fiberName: string }

/** Locale keys that name one Capabilities component. */
export type CapabilitiesComponentLabelKey =
  | 'networkSubprocess'
  | 'directoryPickerBackend'
  | 'directoryPicker'
  | 'brand'
  | 'networkSettings'

/** Locale keys for one component's plain-language description. */
export type ComponentDescriptionKey =
  | 'networkSubprocessDescription'
  | 'directoryPickerBackendDescription'
  | 'directoryPickerDescription'
  | 'brandDescription'
  | 'networkSettingsDescription'

/** One product component listed on the Desktop Capabilities detail page. */
export interface CapabilitiesComponent {
  /** Stable product id for the roster row. Shown as the short code line. */
  id: string
  /** Locale key for the row label. */
  labelKey: CapabilitiesComponentLabelKey
  /** Locale key for the sentence under the label. */
  descriptionKey: ComponentDescriptionKey
  /** Live-state source: Host inventory row or Client feature fiber. */
  source: CapabilitiesComponentSource
  /**
   * Package specifier shown on the row.
   * Internal features use `capabilitiesFeatureModuleName`; independent Loader packages use their npm name.
   */
  moduleName: string
}

/**
 * Official items this feature adds. Upstream official items stay on the page.
 */
export const OFFICIAL_ROOT_ITEMS: readonly OfficialRootItem[] = [
  {
    id: 'desktop-capabilities',
    order: 120,
    labelKey: 'capabilities',
    descriptionKey: 'capabilitiesDescription',
    packageName: DESKTOP_CAPABILITIES_PACKAGE,
    version: DESKTOP_CAPABILITIES_VERSION,
  },
]

/**
 * Product roster shown under Desktop Capabilities. Rows cannot be switched;
 * displayed phase comes from Host `pluginInventory/list` or the Client fiber.
 */
export const CAPABILITIES_COMPONENTS: readonly CapabilitiesComponent[] = [
  {
    id: 'network-subprocess',
    labelKey: 'networkSubprocess',
    descriptionKey: 'networkSubprocessDescription',
    source: { kind: 'inventory', moduleName: '@dsh-electron/dsh-electron-network-subprocess' },
    moduleName: '@dsh-electron/dsh-electron-network-subprocess',
  },
  {
    id: 'directory-picker-backend',
    labelKey: 'directoryPickerBackend',
    descriptionKey: 'directoryPickerBackendDescription',
    source: { kind: 'inventory', moduleName: '@deepseek-ai/dsh-host-directory-picker-browse' },
    moduleName: '@deepseek-ai/dsh-host-directory-picker-browse',
  },
  {
    id: 'directory-picker',
    labelKey: 'directoryPicker',
    descriptionKey: 'directoryPickerDescription',
    source: { kind: 'fiber', fiberName: 'directory-picker' },
    moduleName: capabilitiesFeatureModuleName('directory-picker'),
  },
  {
    id: 'brand',
    labelKey: 'brand',
    descriptionKey: 'brandDescription',
    source: { kind: 'fiber', fiberName: 'brand' },
    moduleName: capabilitiesFeatureModuleName('brand'),
  },
  {
    id: 'network-settings',
    labelKey: 'networkSettings',
    descriptionKey: 'networkSettingsDescription',
    source: { kind: 'fiber', fiberName: 'network-settings' },
    moduleName: capabilitiesFeatureModuleName('network-settings'),
  },
]

/** Every row whose live phase the inventory watcher publishes. */
export const TRACKED_COMPONENTS: readonly CapabilitiesComponent[] = CAPABILITIES_COMPONENTS

/**
 * Rows for the Desktop Capabilities Official detail page.
 * @param id - `plugins.item` id.
 * @returns the Capabilities roster, or undefined for any other subject.
 */
export function componentsForItem(id: string): readonly CapabilitiesComponent[] | undefined {
  if (id === 'desktop-capabilities') return CAPABILITIES_COMPONENTS
  return undefined
}
