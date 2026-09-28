# Agent Note: Electron 必需的 portable UI 基础设施

Status: implemented

[English](2026-08-24-electron-required-portable-ui-infrastructure.md) | 中文

## Problem

Desktop 需要内置的 Client UI：它必须 portable（不含 Electron、`ctx.desktop`、preload import），必须不可被用户通过 Plugin Manager 禁用，且源码真源不是 Electron monorepo。上游 DSH 把这类功能放在 `packages/` 与公共插件仓库；Desktop 必须把它们安装进自己的 runtime plugin 清单，同时不把它们变成 ecosystem 插件。

## Decision

`dshElectron.runtimePlugins` 可以承载 Electron 必需的 portable DSH UI 基础设施：一个 `platform: web` 公共包，其 canonical 仓库独立，源码不进入本仓库。Desktop 以精确版本 production 依赖安装其已发布的 npm artifact，校验它，并链接其 Host 与 Client artifacts，不重新构建。

该包只使用上游 DSH client 服务，作为必需的 `host.patch.yml` 行组合（而非用户可管理的插件），永不加入 `dshElectron.ecosystemPlugins`。在消费者调用已发布服务之前，加载该包 MUST NOT 占用产品 UI。

当前的 `dshElectron.runtimePlugins` 列表为空。Theme Studio 是用户可管理的 ecosystem bundle（[profile 所有权说明](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.zh.md)）；Details Host 在上游移除 Client `details` 插槽后已被删除（[删除说明](2026-09-13-electron-remove-details-host.zh.md)）。

Desktop 安装此类别已发布的 artifacts，而不是自行构建，同时仍禁止 Electron、`ctx.desktop` 与 preload import。用户可禁用的产品功能按照 [npm-only ecosystem plugin 规则](2026-09-14-electron-npm-only-ecosystem-plugins.zh.md)保留为独立发布的 npm 依赖。

## Alternatives considered

**作为可管理的生态插件发布。** 拒绝：用户可以通过 Plugin Manager 禁用必需 UI 基础设施。

**把 subtree 镜像保留为 Electron 的加载真源。** 拒绝：同一个产物会因此拥有两个权威：镜像可能与已发布的 npm 构建产生偏差，源码 checkout 可以通过，而打包应用加载的是另一份 bundle。

**打包 Desktop 专用变体而非 portable 包。** 拒绝：portable 构建必须与独立 `dsh` 用户安装的产物保持一致。

## Consequences

Desktop 的 required-UI 清单只靠 `host.patch.yml` 行区分已挂载成员与缺席插件；添加成员而不挂载会静默发布死代码。

安装未来的成员需要为其固定版本的 production 依赖访问 registry；更新它需要显式修改 dependency pin 与 lockfile。
