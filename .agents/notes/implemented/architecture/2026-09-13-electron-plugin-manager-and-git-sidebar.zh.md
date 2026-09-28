# Agent Note: Desktop 使用 Web Plugin Manager，并通过 sidebarRight 组合 Git

Status: implemented

[English](2026-09-13-electron-plugin-manager-and-git-sidebar.md) | 中文

## Problem

0.1.5-rc.2 pin 让 Plugin Manager 与 Git 都不进入组合，因为 Git 占用了已被移除的 Client `details` 插槽（[Git 卸载](2026-09-13-electron-unmount-git-plugin.zh.md)）。`settings.plugins.tab` 仍然存在，因此 Installed tab 可以在不挂 Details Host 的情况下重挂。Git 需要 Sidebar 移植后才能回到 `dshElectron.ecosystemPlugins`。

## Decision

Web profile 挂载上游 Plugin Manager。Desktop Host patch 不再插入独立的 Electron manager。

`@dsh-electron/dsh-plugin-git@0.2.3` 注入 `sidebarRight` / `sidebarRightTabs`，运行时不依赖 `details`、`shellDetails` 或 `@dsh-electron/dsh-client-ui-details-host`。Desktop 把该 package 列入 `dshElectron.ecosystemPlugins`，并按照 [npm-only ecosystem plugin 规则](2026-09-14-electron-npm-only-ecosystem-plugins.zh.md)保留其精确版本 production npm 依赖。

## Alternatives considered

**重挂 Details Host 以便加载旧的 Git Client。** 拒绝：上游仍然没有 `details` 插槽。

**Sidebar 移植落地后只重挂 Plugin Manager，继续不组合 Git。** 拒绝：该移植已不含 details，且 `sync-version` 可以保住 production 依赖。

**删除 Details Host 目录。** 当时拒绝：在插槽缺失期间，subtree 身份仍然有用。该镜像此后已被删除（[删除说明](2026-09-13-electron-remove-details-host.zh.md)）。

## Consequences

上游 Plugin Manager 提供 Installed 视图。Git UI 位于右侧边栏。Desktop 把 Git package seed 进 web profile；`host.patch.yml` 不再插入它。

参见[由 profile 管理的 ecosystem 插件](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.zh.md)了解 seed、Disable 与 Uninstall，以及 ownership overlay 规则。
