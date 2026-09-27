/** Simplified Chinese copy for Desktop-required plugin cards. */
export const zh = {
  builtIn: 'Desktop 内置',
  required: 'Desktop 必需，无法关闭',
  networkSubprocess: '网络子进程',
  directoryPickerBrowse: '目录选择（浏览）',
  capabilities: '桌面能力',
  themeStudio: '主题工作室',
  directoryPicker: '目录选择',
  brand: '品牌',
  networkSettings: '网络设置',
  desktopPlugins: 'Desktop 插件',
} as const

/** English copy follows the same typed keys. */
export const en = {
  builtIn: 'Built into Desktop',
  required: 'Required by Desktop. It cannot be turned off.',
  networkSubprocess: 'Network subprocess',
  directoryPickerBrowse: 'Directory picker (browse)',
  capabilities: 'Desktop capabilities',
  themeStudio: 'Theme Studio',
  directoryPicker: 'Directory picker',
  brand: 'Brand',
  networkSettings: 'Network settings',
  desktopPlugins: 'Desktop plugins',
} satisfies Record<keyof typeof zh, string>

export type DesktopPluginsLocaleKey = keyof typeof zh
