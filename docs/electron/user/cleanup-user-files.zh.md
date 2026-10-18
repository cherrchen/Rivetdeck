# 清理 Rivetdeck 用户文件

[English](cleanup-user-files.md) | 中文

本指南列出 Rivetdeck 移除后遗留的文件，以及各平台上删除剩余内容的方法。卸载只删除程序与可重建数据；下列位置保存设置、凭据、浏览器存储或共享代理数据，永远不会被自动删除。完整的归属与安全策略见[卸载与数据清理](../uninstall-data-cleanup.zh.md)设计文档。

## Windows（NSIS 安装包）

assisted NSIS 卸载器会删除安装目录、`managed-toolchains/`、`electron/toolchains/bin`、具名 Chromium 缓存目录（`Cache/`、`Code Cache/`、`GPUCache/`、`DawnGraphiteCache/`、`DawnWebGPUCache/` 及各分区的对应目录）和 `%LOCALAPPDATA%\rivetdeck-updater`。更新与卸载器替换完全不删除数据。

| 位置 | 内容 | 卸载后 |
| --- | --- | --- |
| `%APPDATA%\Rivetdeck` | `desktop-preferences.json`、`network-secrets/`、`network-startup-override.json`、Cookies、`Local Storage/`、`IndexedDB/`、非缓存会话分区数据 | 保留——如需删除请手动删除该目录 |
| `%APPDATA%\Rivetdeck-uninstall-residue.log` | 上一次卸载中跳过的目标与删除失败记录 | 手动删除 |
| `%LOCALAPPDATA%\rivetdeck-updater` | 下载的更新包 | 由卸载器删除 |
| `%APPDATA%\rivetdeck-path-history.ini` | 产品使用过的全部 `userData` 与 `DSH_HOME` 根目录记录 | 保留——后续卸载依靠它保护或删除正确的根目录；不需要时可手动删除 |

运行 `"Uninstall Rivetdeck.exe" --delete-app-data` 会请求删除整个 `%APPDATA%\Rivetdeck`。仅当该安装的路径历史记录存在且完整时才会执行；否则该目录被跳过并写入残留日志。如需强制删除，请手动移除 `%APPDATA%\Rivetdeck`。

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

如果应用曾以 `--user-data-dir` 或其他 `DSH_HOME` 运行，`%APPDATA%` 旁的 `rivetdeck-path-history.ini` 会记录它使用过的全部根目录。
