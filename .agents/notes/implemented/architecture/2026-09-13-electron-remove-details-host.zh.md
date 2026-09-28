# Agent Note: Electron 删除 Details Host 镜像

Status: implemented

[English](2026-09-13-electron-remove-details-host.md) | 中文

## Problem

上游 `dsh-v0.1.5-rc.2` 移除了 Client `details` 插槽，`@dsh-electron/dsh-client-ui-details-host` 已无栏位可承载。`apps/electron/runtime/plugins/ui-details-host` 下未挂载的 subtree 镜像仍以被删除的 API 为目标：它注册 `details` occupant，并调用 `ctx.layout.openDetails()` / `closeDetails()`，而当前 `ILayout` 已没有这两个方法。由于 `tsconfig.runtime-client.json` 纳入所有 `runtime/plugins/*/src/client` 目录，Desktop 会用 workspace 类型检查这份源码；而该镜像发布的 0.1.2-rc.1 `peerDependencies` 使它停留在上游已删除的 API 上。存在（或被忽略）的嵌套 `node_modules` 会把 peer 解析到旧声明文件并在本地掩盖破坏；干净检出——CI——会将其暴露。

## Decision

镜像已删除。本仓库不再包含 `ui-details-host` 目录、对 `@dsh-electron/dsh-client-ui-details-host` 的依赖、专用 Electron 集成测试或该包的 client 路径别名。

被删除的表面保持缺席：已发布的 Git package 改用 `sidebarRight`，并由 Desktop Host patch 插入。runtime plugin 清单与 reserved package 名单均不再引用 Details Host。

重新引入需要 Client 占用插槽（Sidebar 或恢复的 Details 栏）以及消费者，并从 canonical 仓库 `cherrchen/dsh-client-ui-details-host` 重新以 git subtree 镜像加入。本说明合并并取代 2026-09-13 的 Details Host 卸载说明；卸载决策在此保留，不再单列记录。

## Alternatives considered

**把镜像从 `tsconfig.runtime-client.json` 排除。** 否决：被排除的目录不被任何检查程序覆盖，而 runtime plugin 清单、发现测试与打包仍携带它，其源码会静默腐坏。

**保留未挂载的树。** 在 type-check 事故后否决：它需要排除法兜底，而 subtree 历史与 canonical 仓库已保证源码可恢复，且 [Sidebar 组合说明](2026-09-13-electron-plugin-manager-and-git-sidebar.zh.md)在 Git 迁移到 `sidebarRight` 后移除了它最后一个消费者。

**基于当前 layout API 重写 Details Host。** 否决：上游 Client 没有可承载的第三栏或 details 服务；那是上游产品决策，不是 Desktop 镜像层补丁。

## Consequences

`apps/electron/tsconfig.runtime-client.json` 只编译本地 runtime plugin 的 client 目录，CI 因此检查该清单，嵌套的陈旧依赖不再可能掩盖 workspace API 破坏。Theme Studio 与 Git 是由 profile 管理的 ecosystem bundle（[profile 所有权说明](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.zh.md)）；[必需 portable UI 基础设施](2026-08-24-electron-required-portable-ui-infrastructure.zh.md)类别目前没有成员。
