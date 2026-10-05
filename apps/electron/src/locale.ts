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
  networkSettingsSaveFailed: 'Network settings could not be saved.',
  menuFile: 'File',
  menuEdit: 'Edit',
  menuView: 'View',
  menuAbout: 'About {name}',
  menuQuitNamed: 'Quit {name}',
  menuQuit: 'Quit',
  menuShow: 'Show {name}',
  menuCheckUpdates: 'Check for Updates…',
  menuCheckingUpdates: 'Checking for Updates…',
  menuDownloadingUpdate: 'Downloading Update…',
  menuDownloadingUpdateProgress: 'Downloading Update… {progress}%',
  menuRestartInstall: 'Restart to Install Update',
  menuUpdateChannel: 'Update Channel',
  menuChannelPrerelease: 'Pre-Release',
  menuChannelStable: 'Stable / Release',
  aboutWindowTitle: 'About {name}',
  aboutVersionLabel: 'Version',
  aboutBuildLabel: 'Build',
  aboutCommitLabel: 'Commit',
  aboutBody: 'Desktop application built on DeepSeek Harness with its local Web interface.',
  aboutHomepage: 'Homepage',
  aboutGitHub: 'GitHub',
  updatePackagedOnlyTitle: 'Updates are checked in packaged builds',
  updatePackagedOnlyDetail: 'Build and install a release package to test the GitHub update channel.',
  updateCheckingTitle: 'Checking for updates',
  updateCheckingDetail: 'A {channel} update check is already in progress.',
  updateDownloadingTitle: 'Downloading update',
  updateDownloadingDetail: 'The update is downloading in the background.',
  updateDownloadingDetailProgress: 'The update is downloading in the background ({progress}%).',
  updateUpToDate: '{name} is up to date',
  updateNoPublishedDetail: 'No published version is available on the {channel} update channel.',
  updateFoundTitle: 'Update found',
  updateFoundDetail: 'Version {version} is downloading in the background.',
  updateCurrentNewestDetail: 'Version {version} is the newest available version on the {channel} update channel.',
  updateCheckFailedTitle: 'Unable to check for updates',
  updateCheckFailedDetail: 'GitHub Releases could not be reached. Check your network connection and try again.',
  updateReadyNotificationTitle: '{name} update ready',
  updateReadyNotificationBody: 'Version {version} was downloaded. Click to restart and install it.',
  updateReadyTitle: 'Update ready to install',
  updateReadyRestartDetail: 'Restart {name} to finish installing the downloaded update.',
  updateReadyVersionDetail: 'Version {version} is ready. Restart {name} to finish installing it.',
  updateRestartInstall: 'Restart and install',
  updateLater: 'Later',
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
  networkSettingsSaveFailed: '无法保存网络设置。',
  menuFile: '文件',
  menuEdit: '编辑',
  menuView: '视图',
  menuAbout: '关于 {name}',
  menuQuitNamed: '退出 {name}',
  menuQuit: '退出',
  menuShow: '显示 {name}',
  menuCheckUpdates: '检查更新…',
  menuCheckingUpdates: '正在检查更新…',
  menuDownloadingUpdate: '正在下载更新…',
  menuDownloadingUpdateProgress: '正在下载更新… {progress}%',
  menuRestartInstall: '重启以安装更新',
  menuUpdateChannel: '更新通道',
  menuChannelPrerelease: '预发布',
  menuChannelStable: '正式版',
  aboutWindowTitle: '关于 {name}',
  aboutVersionLabel: '版本',
  aboutBuildLabel: '构建',
  aboutCommitLabel: '提交',
  aboutBody: '基于 DeepSeek Harness 构建的桌面应用，附带本地 Web 界面。',
  aboutHomepage: '主页',
  aboutGitHub: 'GitHub',
  updatePackagedOnlyTitle: '更新检查仅在打包构建中可用',
  updatePackagedOnlyDetail: '请构建并安装正式安装包后再测试 GitHub 更新通道。',
  updateCheckingTitle: '正在检查更新',
  updateCheckingDetail: '正在进行 {channel} 更新检查。',
  updateDownloadingTitle: '正在下载更新',
  updateDownloadingDetail: '更新正在后台下载。',
  updateDownloadingDetailProgress: '更新正在后台下载（{progress}%）。',
  updateUpToDate: '{name} 已是最新版本',
  updateNoPublishedDetail: '{channel} 更新通道上没有可用的已发布版本。',
  updateFoundTitle: '发现更新',
  updateFoundDetail: '正在后台下载版本 {version}。',
  updateCurrentNewestDetail: '版本 {version} 已是 {channel} 更新通道上的最新版本。',
  updateCheckFailedTitle: '无法检查更新',
  updateCheckFailedDetail: '无法访问 GitHub Releases。请检查网络连接后重试。',
  updateReadyNotificationTitle: '{name} 更新已就绪',
  updateReadyNotificationBody: '版本 {version} 已下载。点击以重启并安装。',
  updateReadyTitle: '更新已就绪，可以安装',
  updateReadyRestartDetail: '重启 {name} 以完成已下载更新的安装。',
  updateReadyVersionDetail: '版本 {version} 已就绪。重启 {name} 以完成安装。',
  updateRestartInstall: '重启并安装',
  updateLater: '稍后',
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

/**
 * Substitute `{name}`-style placeholders in a Main locale template.
 * @param template - Message template from `DesktopMainMessages`.
 * @param values - Named substitutions.
 * @returns the rendered message.
 */
export function formatDesktopMessage(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (match, key: string) => {
    const value = values[key]
    return value === undefined ? match : String(value)
  })
}
