# Agent Note: Electron 将 ecosystem 插件 seed 进 web profile，并按 ownership 去重

Status: implemented

[English](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.md) | 中文

## Problem

Desktop 需要让预装的 Git 与 Theme Studio 出现在 Plugins 页并支持 Enable/Disable，且 Disable 后不能由 Host overlay 重新挂上。CLI 安装与 Plugins 页使用同一 profile 写入。`$DSH_HOME` 里已有的同名包可能让 Desktop 无法启动。

## Decision

required overlay 名称来自静态 `host.patch.yml` insert，而不是 Official roster。Desktop Capabilities 注册唯一由 Electron 拥有的 Official `plugins.item` 卡片；Capabilities 详情页列出产品 Components。共享的 `dsh plugin` 操作首次将 Git 与 Theme Studio 等 ecosystem 插件预装为 pinned dependency 和已启用 bundle。`dsh plugin` 与 Plugins 页使用同一条 profile-managed 路径。

Desktop Capabilities 的 Host half 在每次 profile 组合（包括 HMR）时刷新 ownership overlay。required 名称会禁用 overlay 之前的每一份副本，再由静态 overlay 插入 Desktop 行。已启用的 ecosystem 包保留其自己的 `dsh.bundle.patch` 插入行；额外同名行被禁用。已禁用的 ecosystem 包不会得到 overlay insert。overlay 不插入 Git 或 Theme Studio。

Host half 通过 launcher 提供的 `profileContext.overlays` 属性返回当前 overlay，并在 dispose 时恢复原属性。HMR 在串行的 profile 重载期间读取该属性，因此后来新增的同名行会被禁用，而无需修改上游 CLI 或 boot 包。

Disable 持久保存在 `dsh.profile.bundles`。Uninstall 会去掉共享 dependency，且 Desktop 重启后 CLI 仍保持移除状态；Desktop Host 仅在私有投影中启用随包副本。Electron 不隐藏 Uninstall。required runtime 插件继续在 `profiles/node_modules` 与 `profiles/web/node_modules` 下使用 Desktop-owned 链接。ecosystem 包在磁盘上由 profile 拥有；受监督 Host 仅通过 [Electron process-local ecosystem runtime ownership](2026-09-29-electron-process-local-ecosystem-runtime-ownership.zh.md) 中的进程私有投影覆盖它们。

Official 卡片与 Capabilities 组件名单是产品 roster，不是 Loader 行清单。Desktop Capabilities 详情页带有版本、桌面能力标签和白话的组件说明。组件实时运行状态见 [Desktop Capabilities composition root](2026-09-27-electron-desktop-capabilities-composition-root.zh.md)。

本决策延伸[Web Plugin Manager 与 Git sidebar](2026-09-13-electron-plugin-manager-and-git-sidebar.zh.md)，并保留 [npm-only ecosystem 插件](2026-09-14-electron-npm-only-ecosystem-plugins.zh.md)的发行规则。

[必需 portable UI 基础设施](2026-08-24-electron-required-portable-ui-infrastructure.zh.md)类别仍可用于未来不可禁用的包；Theme Studio 则由 profile 管理。

## Alternatives considered

**向上游 Plugin Manager 增加 `locked` 或 `source=desktop`。** 拒绝：Plugins 页已经用 Official `plugins.item` 卡片与 Installed bundle 区分来源。

**继续用 `host.patch.yml` insert Git。** 拒绝：Disable 无法卸下后一层 overlay insert。

**看见 `name` 等于 Git 就禁用 pre-Electron 中的每一行。** 拒绝：这会关掉 bundle 自己的 canonical `dsh-plugin-git` 行。

**为已 seed 的 ecosystem 插件隐藏 Uninstall。** 拒绝：共享 profile 拥有安装选择，包括移除。

**把 Desktop-only runtime 行写入共享 web profile。** 拒绝：那些行不可移植；同一 `$DSH_HOME` 下的 CLI `dsh web` 不得加载 Electron adapter。

## Consequences

共享 `$DSH_HOME` 的 CLI `dsh web` 仍能看到 Git 与 Theme Studio，并加载 profile 安装副本。Desktop 重启后，Uninstall 的移除结果仍然有效。required 插件在会话内 `pnpm` 重建共享 `node_modules` 后，要到下次启动才会修复。required 插件在 disable 后再 insert 可能留下一个已禁用的同 id 前驱行，与 overlay 行并存；仍然只有一份 active canonical 副本。Desktop Host 对 ecosystem 的 runtime ownership 是进程本地的；见 [Electron process-local ecosystem runtime ownership](2026-09-29-electron-process-local-ecosystem-runtime-ownership.zh.md)。
