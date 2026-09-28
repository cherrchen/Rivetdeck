# Agent Note: Electron Desktop 在本地恢复 DeepSeek Harness 品牌 slot

Status: implemented

[English](2026-08-23-electron-desktop-ui-brand.md) | 中文

## Problem

上游 Web 壳把产品品牌当作部署关注点。没有占位者时，`sidebar.brand.mark`、`sidebar.brand.name` 与 `conversation.hero.brand.mark` 回退为鱼形标记加上 `DSH Local Build` 标签与 commit 徽标；`@deepseek-ai/dsh-client-ui-brand-official` 仅在 client 产物以 `DSH_CLIENT_BUILD_PROFILE=official` 构建时填充这些孔位。DeepSeek Harness Desktop 需要在普通本地与 release 构建中显示 DeepSeek Harness 品牌，且不得修改已同步的 `packages/` 源码，也不得要求每位 Desktop 开发者都跑 official client 构建 profile。

## Decision

`apps/electron/runtime/plugins/desktop-capabilities/src/client/features/brand/` 中的品牌 feature 始终向三个品牌 slot 注入与 official 包相同的 `FishLogo` / `BrandWordmark` 视觉，且不读取 `DSH_CLIENT_BUILD_PROFILE`。它是 `@dsh-electron/dsh-electron-desktop-capabilities` 的内部 Cordis feature，不是独立 Loader 包；见 [Desktop Capabilities composition root](../architecture/2026-09-27-electron-desktop-capabilities-composition-root.zh.md)。文档标题文案仍由 Electron Vite 的独立 `DSH_CLIENT_TITLE` 默认值（`DeepSeek Harness`）负责。

## Alternatives considered

**要求 Desktop 使用 `pnpm run build:official`。** 拒绝：Desktop 打包与日常 `pnpm build` 仍会显示 `DSH Local Build`，除非所有工作流都切换 profile；品牌也会继续耦合到 Host client 产物环境，而不是 Desktop 组合 overlay。

**修改上游 `ui-sidebar` 回退，或在 `packages/client/ui-brand-official` 内强制注册。** 拒绝：分叉规则要求产品级 Desktop 覆盖留在 `apps/electron/**`。

**仅在 Electron Vite `define` 中设置 `DSH_CLIENT_BUILD_PROFILE`。** 拒绝：brand-official 位于 Host 下发的动态 `lib/client.js` 中，其构建期环境已内联；Electron 静态壳的 define 不会改写这些插件。

## Consequences

Desktop 品牌不再依赖上游 official client profile。当 official Host 构建同时挂载 `ui-brand-official` 时，两个占位者可能占用同一组 single slot；Desktop 仍拥有挂载品牌 feature 的组合。聚焦的 Electron 测试覆盖 slot 注册与 teardown，以及无 `DSH_CLIENT_BUILD_PROFILE` 门控。
