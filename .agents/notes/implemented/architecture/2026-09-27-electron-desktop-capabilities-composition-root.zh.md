# Agent Note: Electron Desktop Capabilities 是 Client composition root

Status: implemented

[English](2026-09-27-electron-desktop-capabilities-composition-root.md) | 中文

## Problem

目录选择、品牌、网络设置与 Official Plugins roster 各自作为独立 Loader/npm 包和 overlay 行发布。Plugins 页把每条 overlay insert 都列成 Official 卡，于是 Loader inventory、Official 条目与产品 Components 被强制保持相等。`@dsh-electron/dsh-electron-desktop-capabilities` 使用 `immediately: true` 且 inject 只有 `ui-renderer`；若把那些 Client adapter 并入其 `dsh.client.inject` 并集，会把产品 UI 包拖进 stage-one。

## Decision

`@dsh-electron/dsh-electron-desktop-capabilities` 是唯一的 Desktop Client Loader/npm 包。其 Host half 仍为空。其唯一的 `lib/client.js` 先提供 `ctx.desktop`，再用 Cordis `ctx.plugin()` 挂载内部 feature 插件。feature 位于 `src/client/features/{directory-picker,brand,network-settings,plugin-manager}/`，导出 `name` / `inject` / `apply` 且无 default export，不是 npm 包、Loader 行或 npm subpath 插件。

composition 包不是 `immediately: true`。`dsh.client.inject` 是原先 Client adapter 的并集并去掉自引用；`dsh.client.external` 保留 `@deepseek-ai/dsh-client-ui-primitives`。`ctx.desktop` 随 application batch 激活。需要它的 feature 声明 Cordis `inject: ['desktop', …]`。外部 Desktop-aware 插件继续 `ctx.inject(['desktop'], …)`。

Plugins 页仅为 Desktop Capabilities 与 Theme Studio 注册 Official `plugins.item` 卡片。Capabilities 详情页列出五条产品 Components（网络子进程、目录选择后端、目录选择、品牌、网络设置）。每行显示包名：内部 feature 为 `@dsh-electron/dsh-electron-desktop-capabilities/<feature>`，独立 Loader adapter 用各自的 npm 名。这些名字是展示用，不是 Loader 行。条目不能 Enable、Disable 或 Uninstall。Loader 行与 Theme Studio 的显示状态来自 Host `pluginInventory/list`；directory-picker、brand、network-settings 来自 Client feature fiber。Desktop Capabilities 详情页显示版本标签、桌面能力标签、包名，以及白话的组件说明。Theme Studio 详情页显示版本和包名，不带实验性标签，并只列一行，标题为 `@dsh-electron/dsh-theme-studio`，patch id 为 `theme-studio`。

`host.patch.yml` 插入四条 Loader 行：network-subprocess、directory-picker-browse、desktop-capabilities 与 theme-studio。ownership overlay 的 required 名称来自这些静态 insert 包名。`@dsh-electron/dsh-electron-network-subprocess` 仍是独立 Host provider。Theme Studio 仍是 portable npm runtime 插件。Git 仍是 ecosystem bundle。`@dsh-electron/dsh-electron` 是应用包，不是插件父包。

本决策延伸 [类型化 Main 桥所有权](2026-08-21-electron-desktop-capability-ownership.zh.md)，保留 [本地品牌占用](../feature/2026-08-23-electron-desktop-ui-brand.zh.md)，并在 [ecosystem seed 与 ownership overlay](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.zh.md) 中把 Official 卡与 overlay insert 分开。

## Alternatives considered

**保留四个独立包，只藏 Official 卡片。** 拒绝：Client adapter 仍会是 Loader 行、overlay insert 与 discovery inventory；Plugin Manager 仍会呈现平行的产品树。

**把 feature 做成 npm subpath Loader 插件（`…/ui-brand`）。** 拒绝：Client 模块系统把 browser half 绑到裸包名；subpath 行没有自己的 `lib/client.js`。

**把 feature 嵌进 `@dsh-electron/dsh-electron` 应用包。** 拒绝：该包是 Electron 应用，不是 Loader 插件。

**现在就把 `desktop-network-subprocess` 并入 capabilities Host half。** 拒绝：在证明 fiber 顺序、`LocalSubprocessRuntime` 子类与 `DSH_ELECTRON_AGENT_PROXY_POLICY` 之前保持独立 Loader 行。

## Consequences

`runtime/plugins/` discovery 只看到 desktop-capabilities 与 desktop-network-subprocess。测试把 overlay insert 名称、Official item id 与 Capabilities Components 锁成三份名单。声明了 `inject: ['desktop']` 的 feature 会等到 Service 提供 `ctx.desktop`，即使父 `apply` 先 `ctx.plugin` 它们。父 fiber dispose 会清掉 feature 的 slot 与 locale 词典。Theme Studio 仍不声明 `desktop` inject。
