# Agent Note: Electron 将 ecosystem 插件 seed 进 web profile，并按 ownership 去重

Status: implemented

[English](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.md) | 中文

## Problem

Desktop 需要让 Git 出现在官方 Plugins 页并支持 Enable/Disable，但不能改 `packages/` 或上游 Plugin Manager，也不能在 Disable 之后仍由 Host overlay 重新挂上 Git。CLI 安装与 Plugins 页曾是同一写入的两套说法。`$DSH_HOME` 里已有的同名包可能让 Desktop 无法启动。

## Decision

Electron 不改 `packages/`、`apps/web` 或上游 `docs/`。required overlay 名称来自静态 `host.patch.yml` insert，而不是 Official roster。Official `plugins.item` 卡片是 Desktop Capabilities 与 Theme Studio；Capabilities 详情页列出产品 Components。Git 等 ecosystem 插件被 seed 进 `$DSH_HOME/profiles/web`，作为 pinned dependency，并在首次 seed 时作为已启用 bundle。`dsh plugin` 与 Plugins 页是同一条 profile-managed 路径。

ownership overlay 扫描 bundle 层、`profiles/web/cordis.patch.yml` 与 `$DSH_HOME/cordis.patch.yml`，顺序与 `readProfilePatches()` 去掉 `--patch` 和 telemetry 之前一致。required 名称会禁用 pre-Electron 中的每一份副本，再由静态 overlay 插入唯一 Desktop canonical 行。已启用的 ecosystem 包保留其自己的 `dsh.bundle.patch` 插入行；额外同名行被禁用。已禁用的 ecosystem 包不会得到 overlay insert。overlay 永不插入 Git。

Disable 持久保存在 `dsh.profile.bundles`。Uninstall 会去掉 dependency；下次 Desktop 启动会再次 seed 并启用。Electron 不隐藏 Uninstall。每次启动都会恢复 `profiles/node_modules` 与 `profiles/web/node_modules` 下的 Desktop-owned 链接。

required 的 `plugins.item` 文案是 Built into Desktop / Required by Desktop。Official 卡片与 Capabilities Components 名单是产品 roster，不是 Loader 行清单。组件实时运行状态见 [Desktop Capabilities composition root](2026-09-27-electron-desktop-capabilities-composition-root.zh.md)。

本决策延伸[Web Plugin Manager 与 Git sidebar](2026-09-13-electron-plugin-manager-and-git-sidebar.zh.md)，并保留 [npm-only ecosystem 插件](2026-09-14-electron-npm-only-ecosystem-plugins.zh.md)的发行规则。

## Alternatives considered

**向上游 Plugin Manager 增加 `locked` 或 `source=desktop`。** 拒绝：Desktop 不得改 `packages/`，且 Plugins 页已经用 Official `plugins.item` 卡片与 Installed bundle 区分来源。

**继续用 `host.patch.yml` insert Git。** 拒绝：Disable 无法卸下后一层 overlay insert。

**看见 `name` 等于 Git 就禁用 pre-Electron 中的每一行。** 拒绝：这会关掉 bundle 自己的 canonical `dsh-plugin-git` 行。

**为已 seed 的 ecosystem 插件隐藏 Uninstall。** 拒绝：那会再做一套管理系统；下次 Desktop 启动再 seed 是接受的恢复方式。

**把 Desktop-only runtime 行写入共享 web profile。** 拒绝：那些行不可移植；同一 `$DSH_HOME` 下的 CLI `dsh web` 不得加载 Electron adapter。

## Consequences

共享 `$DSH_HOME` 的 CLI `dsh web` 也能看到 Git。Uninstall 只是临时移除，直到下次 Desktop 启动。会话内 `pnpm` 重建 `node_modules` 要到下次启动才会修复。required 插件在 disable 后再 insert 可能留下一个已禁用的同 id 前驱行，与 overlay 行并存；仍然只有一份 active canonical 副本。
