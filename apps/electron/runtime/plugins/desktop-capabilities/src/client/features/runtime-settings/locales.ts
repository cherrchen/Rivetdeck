/** Desktop runtime setup, lifecycle, and failure dictionaries. */
export const en = {
  title: 'Runtime Environments', setup: 'Optional Runtime Environments',
  intro: 'Install managed environments for Agent tasks. These are optional and can be installed or removed later in Settings.',
  node: 'Node.js', python: 'Python', nodeHint: 'Includes Node.js, npm and npx for JavaScript and TypeScript tasks.',
  pythonHint: 'Includes Python and pip for scripts, data analysis and Python tools.',
  skip: 'Skip for now', selected: 'Install selected runtimes', install: 'Download', retry: 'Retry', cancel: 'Cancel download',
  remove: 'Remove', update: 'Update', reinstall: 'Reinstall', managed: 'Managed by DeepSeek Harness', restart: 'Restart to apply',
  restartHint: 'Changes apply after restart. Running tasks keep their current environment.',
  'not-installed': 'Not installed', downloading: 'Downloading', verifying: 'Verifying', installing: 'Installing',
  installed: 'Installed', 'update-available': 'Update available', removing: 'Restart to complete removal', failed: 'Failed',
  downloadError: 'Download failed. Check your connection and Network Settings, then retry.',
  checksumError: 'Checksum verification failed. Retry to download a verified archive.', archiveError: 'Archive extraction failed. Retry the installation.',
  verificationError: 'Runtime verification failed. Reinstall the environment.', diskError: 'Insufficient disk space. Free some space and retry.',
  interruptedError: 'Installation was interrupted. You can retry.', corruptError: 'Runtime is damaged or unavailable. Reinstall it.',
  operationError: 'The runtime operation failed. Retry or restart the application.', loadError: 'Runtime settings could not be loaded.',
  close: 'Close', removeTitle: 'Remove runtime environment', removeHint: 'Removal takes effect after restart. Running tasks keep their current environment.', keep: 'Cancel', confirmRemove: 'Confirm removal',
}
/** Locale keys are shared across both supported Desktop languages. */
export type RuntimeLocaleKey = keyof typeof en
/** Simplified Chinese runtime dictionary. */
export const zh: Record<RuntimeLocaleKey, string> = {
  title: '运行环境', setup: '可选运行环境', intro: '为 Agent 任务安装托管运行环境。这些环境不是必需的，之后可随时在设置中安装或移除',
  node: 'Node.js', python: 'Python', nodeHint: '包含 Node.js、npm 和 npx，适用于 JavaScript 和 TypeScript 任务',
  pythonHint: '包含 Python 和 pip，适用于脚本、数据分析和 Python 工具',
  skip: '暂时跳过', selected: '安装所选环境', install: '下载', retry: '重试', cancel: '取消下载', remove: '移除', update: '更新', reinstall: '重新安装',
  managed: '由 DeepSeek Harness 管理', restart: '重启以应用', restartHint: '更改将在重启后生效，正在执行的任务继续使用当前环境',
  'not-installed': '未安装', downloading: '正在下载', verifying: '正在校验', installing: '正在安装', installed: '已安装', 'update-available': '有可用更新',
  removing: '重启以完成移除', failed: '失败', downloadError: '下载失败，请检查连接和网络设置后重试', checksumError: '校验失败，请重试以下载通过校验的归档',
  archiveError: '解压失败，请重试安装', verificationError: '运行环境验证失败，请重新安装', diskError: '磁盘空间不足，请释放空间后重试',
  interruptedError: '安装已中断，可以重试', corruptError: '运行环境损坏或不可用，请重新安装', operationError: '操作失败，请重试或重启应用',
  loadError: '无法加载运行环境设置', close: '关闭', removeTitle: '移除运行环境', removeHint: '移除将在重启后生效，正在执行的任务继续使用当前环境', keep: '取消', confirmRemove: '确认移除',
}
