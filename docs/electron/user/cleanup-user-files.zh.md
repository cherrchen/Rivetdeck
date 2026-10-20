# 清理 Rivetdeck 用户文件

[English](cleanup-user-files.md) | 中文

本指南列出 Rivetdeck 移除后遗留的文件，以及各平台上删除剩余内容的方法。卸载只删除程序与可重建数据；下列位置保存设置、凭据、浏览器存储或共享代理数据，永远不会被自动删除。完整的归属与安全策略见[卸载与数据清理](../uninstall-data-cleanup.zh.md)设计文档。

## Windows（NSIS 安装包）

assisted NSIS 卸载器会删除安装目录、`managed-toolchains/`、`electron/toolchains/bin`、具名 Chromium 缓存目录（`Cache/`、`Code Cache/`、`GPUCache/`、`DawnGraphiteCache/`、`DawnWebGPUCache/` 及各分区的对应目录）和 `%LOCALAPPDATA%\rivetdeck-updater`。只有路径历史完整时才会删除具名缓存、托管运行时目录树与更新器缓存；历史缺失或不完整时会整体保留这些目标，并将其列入残留报告。在遗留用户数据上重装会保持历史不完整。更新与卸载器替换完全不删除数据。

| 位置 | 内容 | 卸载后 |
| --- | --- | --- |
| `%APPDATA%\Rivetdeck` | `desktop-preferences.json`、`network-secrets/`、`network-startup-override.json`、Cookies、`Local Storage/`、`IndexedDB/`、非缓存会话分区数据 | 保留——如需删除请手动删除该目录 |
| `%APPDATA%\Rivetdeck-uninstall-residue.log` | 上一次卸载中跳过的目标与删除失败记录 | 手动删除 |
| `%LOCALAPPDATA%\rivetdeck-updater` | 下载的更新包 | 仅在历史完整且校验成功时删除 |
| `%APPDATA%\rivetdeck-path-history.ini` | 本次安装的 `userData` 根目录及历史 `DSH_HOME` 保护记录 | 保留并退役清理候选；重新安装后不会清理前次安装的根目录。不需要时可手动删除 |

运行 `"Uninstall Rivetdeck.exe" --delete-app-data` 会请求删除整个 `%APPDATA%\Rivetdeck`。仅当该安装的路径历史记录存在且完整时才会执行；否则会跳过完整删除，保留具名缓存、托管运行时目录树与更新器缓存，并在残留日志中列出跳过的目标。如需强制删除，请手动移除 `%APPDATA%\Rivetdeck`。清理错误或辅助程序调用错误会显示警告，程序卸载继续。残留报告无法写入时，警告会显示 Windows 错误码与跳过的目标数；请手动检查剩余文件。

## macOS

没有卸载器：将 `Rivetdeck.app` 拖入废纸篓即可。如需删除剩余数据，请删除 `~/Library/Application Support/Rivetdeck`（保存偏好设置、网络凭据与浏览器存储）和 `~/Library/Caches/rivetdeck-updater`（保存下载的更新包）。

## Linux

AppImage 是单个文件——直接删除即可。DEB 包会移除 `/opt/Rivetdeck`。如需删除剩余数据，请删除 `~/.config/Rivetdeck`（保存偏好设置、网络凭据与浏览器存储）和 `${XDG_CACHE_HOME:-~/.cache}/rivetdeck-updater`（保存下载的更新包）。

## 共享根目录——永不删除

以下位置属于 Harness 或用户本人，任何卸载或清理流程都不会删除：

- `~/.dsh`（`$DSH_HOME`，可通过 `DSH_HOME` 环境变量覆盖；Windows 上为 `%USERPROFILE%\.dsh`）——会话、设置、`.credentials.yaml`、插件以及 `electron/` 用户安装的包。它与其他 Harness 工具共享，仅在确认没有其他工具使用时才可手动删除。
- `~/.agents`——跨代理工具共享的技能。
- 工作区目录——你自己的项目。

## 自定义位置

如果应用曾以 `--user-data-dir` 或其他 `DSH_HOME` 运行，`%APPDATA%` 旁的 `rivetdeck-path-history.ini` 会记录它使用过的根目录。真正卸载会将该次安装的清理候选退役，历史 Harness home 则在重新安装后仍受保护。
