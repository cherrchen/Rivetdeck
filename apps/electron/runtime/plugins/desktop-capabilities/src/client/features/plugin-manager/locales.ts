/** Simplified Chinese copy for Desktop Official cards and the Capabilities roster. */
export const zh = {
  builtIn: 'Desktop 内置',
  required: 'Desktop 必需，无法关闭',
  capabilities: '桌面能力',
  themeStudio: '主题工作室',
  components: '包含的组件',
  countTotal: '共 {count} 个',
  countOff: '{count} 已停用',
  partOff: '已关闭',
  networkSubprocess: '网络子进程',
  directoryPickerBackend: '目录选择后端',
  directoryPicker: '目录选择',
  brand: '品牌',
  networkSettings: '网络设置',
} as const

/** English copy follows the same typed keys. */
export const en = {
  builtIn: 'Built into Desktop',
  required: 'Required by Desktop. It cannot be turned off.',
  capabilities: 'Desktop Capabilities',
  themeStudio: 'Theme Studio',
  components: 'Components',
  countTotal: '{count} total',
  countOff: '{count} off',
  partOff: 'Off',
  networkSubprocess: 'Network subprocess',
  directoryPickerBackend: 'Directory picker backend',
  directoryPicker: 'Directory picker',
  brand: 'Brand',
  networkSettings: 'Network settings',
} satisfies Record<keyof typeof zh, string>

export type DesktopPluginsLocaleKey = keyof typeof zh
