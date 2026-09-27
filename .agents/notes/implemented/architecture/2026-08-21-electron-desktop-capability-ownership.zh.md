# Agent Note: 通过类型化 Main 桥接由 Electron 拥有桌面能力

Status: implemented

[English](2026-08-21-electron-desktop-capability-ownership.md) | 中文

## Problem

在完成 [Electron 独立渲染进程](2026-08-21-electron-standalone-renderer.zh.md) 切割后，`BrowserWindow` 不再加载 Harness HTTP 源，但操作系统桌面能力仍处于分裂状态：目录选择仍走 Host 的 `directory-picker-auto`（Windows 上为 native/Koffi），剪贴板仍走 `navigator.clipboard`，路径打开仍走 `host.openPath`，只有 updater/tray/窗口装饰已在 Electron Main。这种分裂使 Windows 继续依赖 Host native picker worker，模糊 Main 与 Host 的崩溃域，也缺少统一的类型化 preload 桌面意图接口。

## Decision

Electron shell 使用的每项操作系统桌面能力均由 Electron Main 拥有，并仅通过封闭的 `window.deepseekDesktop` 桥暴露（禁止泛化 `invoke`，禁止渲染进程获得 Node 或 Electron API）。DSH Host 仍作为独立受监管进程，负责 Agent、Session、Tool、Model、Workspace、Storage 与插件后端。Electron 启动 Host 时使用 [`apps/electron/runtime`](../../../../apps/electron/runtime) 下的 cordis `--patch` overlay：禁用 Host `directory-picker-auto`，保留 `@deepseek-ai/dsh-host-directory-picker-browse` 以便 `ctx.directoryPicker` 仍能满足 apiproxy 的 inject（不挂载 browse client），并挂载在启动前链接到 `$DSH_HOME/profiles/node_modules` 的 bundled runtime 插件。`@dsh-electron/dsh-electron-desktop-capabilities` 把 preload 桥适配为 `ctx.desktop` 并挂载 Desktop Client feature；目录选择 feature 的占位调用 `ctx.desktop.dialog.pickDirectory()`（Main 使用 `dialog.showOpenDialog`）。品牌 feature 始终填充 `sidebar.brand.*` 与 `conversation.hero.brand.mark`，使 Desktop 在不依赖上游 `DSH_CLIENT_BUILD_PROFILE=official` client 构建的情况下显示 DeepSeek Harness 品牌。Client feature 嵌套见 [Desktop Capabilities composition root](2026-09-27-electron-desktop-capabilities-composition-root.zh.md)。

上游 UI 仍调用 `navigator.clipboard` 且无注入 seam 时，在 `apps/electron/src/renderer/` 放置窄 shim，直到上游提供注入点。Shell 外部 URL 使用允许列表（`https:`、`http:`、`mailto:`）。Updater、主题与窗口控制可通过桥访问，但 `quitAndInstall` 与 Host 进程生命周期仍属于 Main。应用内文件路径打开在上游 opener seam 出现前仍可使用 Host `host.openPath`；桌面自有调用方使用 `desktop.shell.*`。

Main 通过 `HarnessTransport` 接口与 Host 通信；首个实现是包装现有 loopback 代理的 `HttpHarnessTransport`。彻底移除 HTTP 留待后续；渲染进程永远不获知 Host URL。Host 事件流（`/api/events.mux`、`/api/events.host`）使用 preload 拥有的 MessagePort，经桥上的回调处理器转发：若把 MessagePort 经 `contextBridge` 返回到隔离世界，会得到不可用的克隆，导致 `onConnected` 永不触发、workspace/session 基线为空。

下游分叉面保持在 `apps/electron/**` 与本 Agent Note。不为这些能力修改 `packages/`、`vendor/` 或 `apps/web/`。

## Alternatives considered

**保留 Host native directory picker，仅在 Windows 上 patch 为 browse。** 拒绝：browse 不是 Electron 已拥有的系统选择器，且非 Windows 仍把桌面选择耦合到 Host 插件。

**把 DSH Host 嵌入 Electron Main。** 拒绝：Host/工具崩溃不得拖垮桌面 GUI 进程；[loopback shell](2026-08-14-electron-loopback-shell.zh.md) 的进程拆分仍然成立。

**修改上游 connection/clipboard/picker 包以提供原生 Electron seam。** 拒绝：本里程碑会把下游分叉扩大到 `apps/electron/**` 之外。

**在同一变更中消灭 loopback HTTP。** 拒绝：属于后续里程碑范围；`HarnessTransport` 在 HTTP 仍仅 Main 私有时保持渲染进程解耦。

## Consequences

打包构建必须包含 `runtime/**`：Host patch 模板与每个 bundled 插件的 `lib/` 产物。`build:runtime-plugins` 步骤发现插件清单，并在打包前产出各插件的 Host half 与所有已声明的 ModuleLoader client half；Host 的 package import 保持 external，使插件共享 Host 的 Cordis 实例。聚焦的 `apps/electron` 测试覆盖允许列表、对话框映射、overlay 路径替换、updater/theme 快照、封闭 channel 集合、通用插件构建与链接、stream 释放以及受监督 Host 退出。Chromium clipboard-write 权限在 navigator shim 旁仍作为临时回退保留。产品 UI 主题仍属上游；仅 `nativeTheme` 经桥暴露。
