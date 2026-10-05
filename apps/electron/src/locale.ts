/** Typed English and Chinese copy owned by the Electron Main process. */

export const en = {
  recoveryTitle: 'Rivetdeck could not start',
  recoveryPending: 'Desktop found an interrupted plugin change and could not repair it automatically.',
  recoveryLock: 'Another Desktop plugin change is still running. Wait for it to finish, or repair plugin state.',
  recoveryProfile: 'The web profile plugin list could not be read.',
  recoveryHost: 'The local Harness process did not become ready in time. A plugin may be blocking startup.',
  recoveryInstruction: 'You can disable every manageable plugin and retry, or reset Desktop plugin management without deleting installed packages.',
  recoveryDetails: 'Technical details',
  disableAll: 'Disable all plugins and restart',
  resetManagement: 'Reset plugin management',
  recoveryFailed: 'The repair did not start Harness. Try the other action, or quit and inspect the web profile.',
  networkFailureTitle: 'Proxy Connection Failed',
  networkFailureBody: 'Managed networking is unavailable. Requests stay on the configured route.',
  networkFailureRetry: 'Retry',
  networkFailureDefaultOnce: 'Use Default This Time',
  networkFailureSettings: 'Open Network Settings',
  networkFailureDismiss: 'Do Nothing',
  networkFailurePermanentTitle: 'Use Default from now on?',
  networkFailurePermanentBody: 'Keep Default networking for future launches? Your Manual proxy settings and saved password will be retained.',
  networkFailurePermanentConfirm: 'Always use Default',
  networkFailurePermanentOnce: 'This time only',
  networkCredentialTitle: 'Proxy Authentication Required',
  networkCredentialRejected: 'The proxy rejected the saved credentials. Enter new credentials to retry.',
  networkCredentialRequired: 'The proxy requires Basic authentication.',
  networkCredentialUsername: 'Username',
  networkCredentialPassword: 'Password',
  networkCredentialCancel: 'Cancel',
  networkCredentialUseOnce: 'Use Once',
  networkCredentialSave: 'Save Securely',
  networkCredentialFailed: 'The credentials could not be applied. Check secure storage and try again.',
} as const

/** Every Main locale supplies the complete English key set. */
export type DesktopMainMessages = { readonly [Key in keyof typeof en]: string }

export const zh = {
  recoveryTitle: 'Rivetdeck 无法启动',
  recoveryPending: 'Desktop 发现一次中断的插件变更，且无法自动对账。',
  recoveryLock: '另一次 Desktop 插件变更仍在进行。请等待其结束，或修复插件状态。',
  recoveryProfile: '无法读取 web profile 的插件列表。',
  recoveryHost: '本地 Harness 进程未在时限内就绪。某个插件可能阻塞了启动。',
  recoveryInstruction: '你可以禁用全部可管理插件后重试，或重置 Desktop 插件管理（不会删除已安装的 package）。',
  recoveryDetails: '技术详情',
  disableAll: '禁用所有插件并重启',
  resetManagement: '重置插件管理',
  recoveryFailed: '修复未能启动 Harness。请尝试另一项操作，或退出后检查 web profile。',
  networkFailureTitle: '代理连接失败',
  networkFailureBody: '受管理的网络连接不可用。请求仍保持在已配置的路由上。',
  networkFailureRetry: '重试',
  networkFailureDefaultOnce: '本次使用默认网络',
  networkFailureSettings: '打开网络设置',
  networkFailureDismiss: '暂不处理',
  networkFailurePermanentTitle: '以后都使用默认网络？',
  networkFailurePermanentBody: '以后启动时始终使用默认网络？手动代理配置和已保存的密码会保留。',
  networkFailurePermanentConfirm: '始终使用默认网络',
  networkFailurePermanentOnce: '仅本次',
  networkCredentialTitle: '需要代理认证',
  networkCredentialRejected: '代理拒绝了已保存的凭据。请输入新凭据后重试。',
  networkCredentialRequired: '代理要求 Basic 认证。',
  networkCredentialUsername: '用户名',
  networkCredentialPassword: '密码',
  networkCredentialCancel: '取消',
  networkCredentialUseOnce: '仅本次使用',
  networkCredentialSave: '安全保存',
  networkCredentialFailed: '无法应用凭据。请检查安全存储后重试。',
} as const satisfies DesktopMainMessages

/** Locale payload used by Main-owned windows and dialogs. */
export interface DesktopMainLocale {
  readonly id: 'en' | 'zh-CN'
  readonly messages: DesktopMainMessages
}

/**
 * Resolve Electron's locale to one shipped Main dictionary.
 * @param locale - `app.getLocale()` value.
 * @returns English or Chinese dictionary.
 */
export function resolveDesktopMainLocale(locale: string): DesktopMainLocale {
  return locale.toLowerCase().startsWith('zh')
    ? { id: 'zh-CN', messages: zh }
    : { id: 'en', messages: en }
}
