# DeepSeek Harness Desktop 架构与开发指南

[English](architecture.md) | 中文

> 状态：**下游架构规范**
>
> 范围：`cherrchen/deepseek-harness-electron`，尤其是 `apps/electron/**`
>
> 读者：维护者、coding agent（编程智能体）、评审人与未来贡献者
>
> 本文区分 `develop` 上已存在的 **CURRENT** 行为，与指导后续开发的 **TARGET** 架构。不要把 TARGET 行为写成已经实现。

## 1. 目的

DeepSeek Harness Desktop 是构建于上游 `deepseek-ai/deepseek-harness` 仓库之上的下游 Electron 桌面应用。

本项目同时追求两个目标：

1. 紧密跟随上游 DeepSeek Harness，尽量减少长期存在的下游修改。
2. 提供具备原生能力与下游专属产品功能的一流 macOS、Windows 与 Linux 桌面应用。

架构刻意分离三类关切：

* **Electron Runtime** 拥有桌面生命周期、操作系统集成、安全边界、打包，以及对 Harness 进程的监督。
* **DeepSeek Harness** 仍是应用／运行时核心：agent、会话、工具、模型、存储、profile、Cordis 组合、Host API，以及共享的 client 运行时。
* **Feature Plugins** 是新增独立下游功能与定制产品 UI 的首选落点。

统领性的架构原则是：

> **Electron 是稳定的桌面平台层；DSH/Cordis 插件是可扩展的产品功能层。**

我们当前**并不**打算把 Electron 桌面应用本身做成 Cordis 插件。我们也**并不**打算在 `apps/electron/src/renderer` 内再建第二套独立的产品前端。

## 2. 规范性用语

术语 **MUST**、**MUST NOT**、**SHOULD**、**SHOULD NOT** 与 **MAY** 具有规范效力。

对于事实性描述：

* **CURRENT** 表示已在当前 `develop` 分支上实现。
* **TARGET** 表示面向未来工作的目标架构，可能尚未存在。
* 若本文 CURRENT 描述与代码冲突，以代码为真源，本文 MUST 被修正。
* 若新实现与 TARGET 规则冲突，除非有明确的架构决策更新本文，否则实现 SHOULD 被修改。

## 3. 仓库所有权边界

本仓库是 `deepseek-ai/deepseek-harness` 的下游 fork。

| 区域                         | 所有权     | 规则                                                                                                                          |
| ---------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/**`                | 上游       | 默认由上游拥有；不要在下述例外之外加入下游桌面行为。 |
| `apps/cli/**`                | 上游       | 不要将其作为下游定制面使用。                                                                             |
| `apps/web/**`                | 上游       | Desktop MUST NOT 依赖修改此应用来实现仅桌面端的 UI。                                                            |
| `docs/**`（`docs/electron/**` 除外） | 上游       | 避免会造成同步冲突的下游专属编辑。                                                            |
| `docs/electron/**`           | 下游       | Desktop 架构及 `docs/` 下其他下游拥有的文档。                                                  |
| `apps/electron/**`           | 下游       | 桌面运行时、桌面集成与下游桌面插件的主要归属处。                                        |
| `AGENTS.downstream.md`       | 下游       | fork 专属的开发与 Git 规则。                                                                                      |
| 下游桌面工作流               | 下游       | Desktop CI/CD、发布、晋级与上游同步集成。                                                             |

未来的桌面功能 MUST NOT 仅仅因为本地方便，就把改动散落在上游拥有的包中实现。

# 第一部分 — CURRENT 架构

## 4. 当前架构摘要

当前应用最好概括为：

> **Electron 自有前端 + 受监督的 DSH Web sidecar + 类型化桌面能力桥**

它已不再是围绕 `apps/web` 的简单 Electron 包装层。

```text
┌───────────────────────────────────────────────────────────────┐
│                         Operating System                      │
│                  macOS / Windows / Linux                      │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                         Electron Main                         │
│                                                               │
│  Window / Tray / Menu / Updater / Dialog / Clipboard / Shell │
│  Notification / Theme / Process supervision / Security policy│
│                                                               │
│  ┌─────────────────────────┐    ┌───────────────────────────┐ │
│  │ Typed IPC + Preload     │    │ Custom scheme / proxy     │ │
│  │ window.deepseekDesktop  │    │ dsh-electron://localhost  │ │
│  └────────────┬────────────┘    └─────────────┬─────────────┘ │
└───────────────┼───────────────────────────────┼───────────────┘
                │                               │
                │ desktop capability            │ Host HTTP / WS
                │ calls                         │ transport
                ▼                               ▼
┌───────────────────────────────┐   ┌───────────────────────────┐
│ Electron-owned Renderer       │   │ Supervised DSH process    │
│                               │   │                           │
│ dsh-electron://localhost      │   │ `dsh web`                 │
│                               │   │ 127.0.0.1:<random-port>   │
│ AppWebEntry                   │   │                           │
│ @deepseek-ai/dsh-client-web   │   │ Cordis / DSH Host         │
│ upstream client plugin graph  │   │ agents / sessions / tools │
│ desktop bootstrap/shims       │   │ profiles / storage / APIs │
└───────────────────────────────┘   └───────────────────────────┘
```

重要后果：

* BrowserWindow **不会**加载上游 `apps/web` 应用。
* BrowserWindow **不会**把受监督 Host 的环回 URL 用作页面源。
* Renderer 由 `apps/electron` 拥有并构建。
* Renderer 有意复用上游 DSH client 运行时与 client 插件。
* 上游 Host 作为单独的受监督 `dsh web` 进程运行，以保持兼容。
* 原生 OS 能力留在 Electron Main。

主要实现参考：

* `apps/electron/src/main.ts`
* `apps/electron/src/renderer/main.ts`
* `apps/electron/src/renderer/bootstrap.ts`
* `apps/electron/src/preload/index.ts`
* `apps/electron/src/bridge-types.ts`
* `apps/electron/src/harness/**`
* `apps/electron/src/protocol.ts`
* `apps/electron/runtime/host.patch.yml`
* `docs/electron/plugin-lifecycle.md`

## 5. 当前进程拓扑

### 5.1 Electron Main

**CURRENT**

Electron Main 是桌面运行时的拥有者。

它拥有应用与 BrowserWindow 生命周期、托盘／菜单、更新器、原生主题、对话框、剪贴板、shell 集成、通知、窗口控制、自定义协议、Host 传输、受监督进程生命周期，以及 Electron 本地运行时资源。

Electron Main MUST 继续作为特权 OS 操作的权威。

### 5.2 受监督的 DeepSeek Harness 进程

**CURRENT**

Electron Main 将上游 DSH 作为子进程启动：

```text
Electron Main
    │
    │ spawn
    ▼
Windows: resources/core-runtime/node.exe with one hidden console
Other platforms: Electron executable with ELECTRON_RUN_AS_NODE=1
    │
    ▼
dsh web
    │
    ▼
127.0.0.1:<random-port>
```

Windows 上 Host 运行于随包发布的 Node.js，因为 `electron.exe` 是 GUI 子系统映像：自身没有控制台的进程会让 Windows 为每个控制台子系统后代新建可见控制台，Windows 11 会将其渲染为 Windows Terminal 窗口。随包发布的 Node.js 是控制台子系统映像，并以 `windowsHide` 和一个继承的 stdin 设备句柄启动，因此 Host 持有一个隐藏控制台，job、ACL 与沙箱子进程都继承它；仅用 `CREATE_NO_WINDOW` 会让控制台子系统子进程完全没有控制台，而受限令牌无法为其子进程创建控制台。其它平台继续使用 Electron 的 Node 兼容子模式。

Core Host 执行与插件包操作独立于 Agent 运行环境。Main 拥有可选 Node/Python Runtime Manager、版本化用户数据 generation 和封闭的类型化订阅 API。Host 与客户端启动不要求任何托管运行环境。Desktop subprocess provider 接收 version-2 策略，仅包含验证通过的已安装环境；按请求、项目、用户、原始 PATH、托管 fallback 的顺序搜索，并排除 Host 专用包管理命令。安装更改在重启后生效。[运行环境](runtime-environments.zh.md)说明生命周期、迁移与代理行为。

该 sidecar 拥有上游 Harness 行为：

```text
agents
sessions
tools
models
profiles
Cordis Host graph
Harness persistence
Host APIs
event streams
```

Electron 不会重新实现这些系统。

### 5.3 Electron 自有 Renderer

**CURRENT**

Renderer 在 `apps/electron` 内构建，并从以下地址加载：

```text
dsh-electron://localhost/index.html
```

它使用来自 `@deepseek-ai/dsh-client-web` 的 `AppWebEntry` 启动共享的 DSH client 内核。

因此：

```text
OLD

Electron
  └─ apps/web


CURRENT

Electron
  └─ Electron-owned Renderer
       └─ @deepseek-ai/dsh-client-web
            └─ upstream client plugin graph
```

`apps/web` 不是桌面定制面。

## 6. 当前 Renderer bootstrap

**CURRENT**

由于 BrowserWindow 不再加载 Host 生成的 HTML，`apps/electron/src/renderer/bootstrap.ts` 会重建上游 client bootstrap 所需的最低状态。

它会：

1. 通过 `window.deepseekDesktop.host.getBootstrap()` 请求 Host bootstrap；
2. 创建 `window.__ModuleLoader__`；
3. 加载 Host client preload 脚本；
4. 安装 `window.__DSH_BOOT__`；
5. 启动 `AppWebEntry`。

Renderer bootstrap MUST 保持精薄。

它 MUST NOT 变成：

```text
installMarket()
installTerminal()
installGit()
installMcpManager()
installPromptLibrary()
...
```

独立的产品功能属于插件。

## 7. 当前 Host 传输

**CURRENT**

受监督 Host 绑定环回上的随机端口。

```text
Renderer
   │
   ├─ typed preload IPC
   └─ dsh-electron:// proxy
   │
   ▼
Electron Main
   │
   ▼
HttpHarnessTransport
   │
   ▼
127.0.0.1:<random-port>
   │
   ▼
DSH Host
```

localhost HTTP/WebSocket sidecar **当前并不被视为架构缺陷**。

它是内部传输实现。替换它意味着要再维护一套上游 bootstrap、请求、流、取消、重连与插件传输语义的实现。

因此，移除 localhost 并非当前优先级。

## 8. 当前 Desktop Capability Bridge

**CURRENT**

`window.deepseekDesktop` 是面向 Renderer 的窄桥。

它暴露显式、类型化的能力分组：

```text
host
app
dialog
clipboard
shell
notification
updater
theme
window
plugins
```

不存在通用的 `ipcRenderer.invoke()` 逃生舱口。

这已经是未来 **Desktop Capability Contract** 的基础。

## 9. 当前安全边界

**CURRENT**

BrowserWindow 使用：

```text
contextIsolation = true
nodeIntegration   = false
sandbox           = true
```

信任边界是：

```text
Unprivileged Renderer / Client Plugins
                │
                ▼
           Typed Preload
                │
                ▼
          Closed IPC APIs
                │
                ▼
          Electron Main
                │
                ▼
            OS APIs
```

未来的插件 MUST 守住这一边界。

插件 MUST NOT 仅仅因为运行在 Desktop 就获得原始的 Electron 或 Node 访问权。

## 10. 当前 runtime 插件基础设施

**CURRENT**

Desktop 从两处汇集其所需的 runtime 插件：`apps/electron/runtime/plugins/` 下由 Electron 构建的目录，以及 `dshElectron.runtimePlugins` 中列出的已发布 npm package。公共生态插件是 `dshElectron.ecosystemPlugins` 中列出的精确版本 production npm 依赖；每个 npm 来源都保留其已发布的 Host 与 Client artifacts。

```text
runtime/plugins/*          Desktop adapters, Electron carriers, and Desktop-only integration (build + link)
node_modules/@dsh-electron/*  runtime plugins (dshElectron.runtimePlugins) and ecosystem plugins (dshElectron.ecosystemPlugins)
runtime/host.patch.yml     Host overlay: required Desktop plugins only
scripts/build-runtime-plugins.mjs
src/runtime-plugins.ts     discovery, validation, and required-plugin profile linking
src/ecosystem-profile.ts   seed ecosystem plugins into the web profile as profile-owned installs
src/host-profile.ts        process-private Host resolution projection for ecosystem packages
src/host.ts                supervised Host entry with split persistence vs resolution dirs
src/ownership-overlay.ts   generate ownership patches for current profile layers
```

启动时先校验并仅将 **required runtime 插件** 链接到 `$DSH_HOME/profiles/node_modules/<package-name>` 与 `$DSH_HOME/profiles/web/node_modules/<package-name>`，然后启动受监督 Host。共享的 dsh plugin 包操作首次预装缺失的 ecosystem 插件并修复旧版 Desktop 链接；Desktop 不直接写入它们的共享安装状态。受监督 Host 通过 `$DSH_HOME/electron/host-profile` 解析 ecosystem 包，共享 profile 包保持不变，以便并发 CLI `dsh web` 使用。`host.patch.yml` 挂载必需的 Desktop 插件。web profile 管理已安装 ecosystem bundle 和后续安装插件的启用状态；从 profile 卸载 ecosystem 包后，Desktop Host 仅在私有投影中选择其随包副本（[插件生命周期](plugin-lifecycle.zh.md)）。

Desktop Capabilities 包（`@dsh-electron/dsh-electron-desktop-capabilities`）是 Desktop Client 的 composition root。它把 `window.deepseekDesktop` 适配为 `ctx.desktop`，并挂载内部 feature 插件。只有 Renderer 基础设施与该包可直接读取全局 bridge。

目录选择 feature 填充 workspace directory-flow slot，并调用 `ctx.desktop.dialog.pickDirectory()`。

品牌 feature 始终用 DeepSeek Harness 视觉填充 `sidebar.brand.mark`、`sidebar.brand.name` 与 `conversation.hero.brand.mark`，因此 Desktop 产品品牌不依赖上游 `DSH_CLIENT_BUILD_PROFILE=official` client 构建。

上游 Web bundle 提供 Plugins UI 与 agent tool。Electron 的 `DesktopPluginManager` 报告有效混合运行时清单：Electron-owned 包使用随包 implementation、patch 与版本；普通用户插件使用共享 web profile implementation。`DesktopRuntime` 在 HMR 队列上串行协调外部 CLI 变更与 UI 操作，并等待 Loader 稳定。包持久化仍由共享 web profile 上的上游操作负责；私有投影可丢弃。参见[插件生命周期](plugin-lifecycle.zh.md)。

[网络设置页面](network-settings.zh.md) 是内部 Desktop Client feature。它贡献顶层 `settings.section` 条目，并通过 `ctx.desktop.network` 配置网络、读取脱敏诊断及运行连接测试；Main 持有策略、密码和重启操作。原生故障对话框可以打开此分区，而不改变已选择的路由。

Git（`@dsh-electron/dsh-plugin-git@0.2.4`）是仅从 npm 安装的 bundled ecosystem 插件。其 Client 占用 `ctx.sidebarRight` / `sidebarRightTabs`，并列入 `dshElectron.ecosystemPlugins`。Desktop 首次将 CLI 副本 seed 进共享 web profile。Electron Installed 报告其实际解析的随包版本与来源；Enable 与 Disable 持久保存在共享 profile。

Theme Studio（`@dsh-electron/dsh-theme-studio@0.1.3`）是列入 `dshElectron.ecosystemPlugins` 的预装 ecosystem bundle。其源码真源是 `cherrchen/dsh-theme-studio`；本仓库不保留其任何副本。该包注册**设置 → 通用 → 主题**，并调用 `ctx.theme.overrideTokens()`；Electron Installed 列出其实际随包运行时 package。已发布的 peer 声明包含 `0.1.7-rc.2`。

```text
Feature Plugin
     │
     │ ctx.desktop.*
     ▼
Desktop Capability Provider
     │
     ▼
window.deepseekDesktop
     │
     ▼
Electron Main
     │
     ▼
Native OS APIs
```

`runtime/plugins/<name>/` 下的每个目录都从源码重新构建。`dshElectron.runtimePlugins` 中声明的 portable runtime 插件同样安装、打包并链接其已发布 artifacts，无需重新构建。Portable 产品功能使用独立发布的 `@dsh-electron/dsh-plugin-*` package；Electron 安装、打包并链接其已发布 artifacts，不重新构建或转换。

# 第二部分 — 架构原则

## 11. 保持 Electron Core 稳定

Electron 是基础设施，不是通用的产品功能层。

Electron Core 拥有：

```text
BrowserWindow
application lifecycle
single-instance behavior
tray
menus
updater
native dialogs
native clipboard implementation
native notifications
native theme
shell integration
protocol
preload
IPC validation
security policy
Host process supervision
installer / packaging / signing integration
```

这些 SHOULD NOT 仅仅为了架构对称而被改成 Cordis 插件。

我们明确拒绝如下要求：

> 「Desktop 本身必须是插件。」

## 12. 保持 Renderer bootstrap 精薄

`apps/electron/src/renderer` 是 DSH Client 的载体／bootstrap 层。

它 MAY 包含：

* renderer 入口；
* Host bootstrap 兼容；
* 传输适配器；
* 范围狭窄的兼容 shim；
* Electron 载体专属的 chrome 集成。

它 SHOULD NOT 变成：

```text
apps/electron/src/renderer/
├─ market/
├─ terminal/
├─ git/
├─ mcp/
├─ models/
├─ prompts/
├─ analytics/
└─ file-explorer/
```

那会再造出第二套单体 Web 应用。

## 13. 独立产品功能是插件

合适的插件候选包括：

```text
plugin marketplace
Git integration
terminal product UI
MCP manager
model manager
prompt library
agent/preset management
workspace extensions
session analytics
developer tools
desktop-specific settings
sidebar contributions
conversation extensions
```

不要过度微插件化：

```text
Button
Modal
Dropdown
one settings row
helper function
small internal React component
```

目标是功能模块化，而不是「一切皆插件」。

## 14. 插件请求能力；它们不拥有 Electron

要求的依赖方向：

```text
Feature Plugin
      │
      ▼
Desktop Capability Contract
      │
      ▼
Preload / IPC
      │
      ▼
Electron Main
      │
      ▼
OS
```

禁止的方向：

```text
Feature Plugin
      │
      ├─ import electron
      ├─ import ipcRenderer
      ├─ use Node directly
      └─ bypass privilege validation
```

## 15. 优先遵循上游能力 seam

在创建 Desktop 专属 API 之前，先检查既有的 DSH/Cordis 扩展点：

```text
ctx services
Cordis events
Host/client plugin composition
Conversation nodes
Settings cards
Commands
Jobs
Shell/filesystem/terminal providers
Session events
Agent events
Client UI slots
```

若上游已提供正确抽象，就使用它。

只有真正需要 Desktop 权威的部分才应进入 Electron。

## 16. 最小化上游 fork 面

Desktop 专属行为 SHOULD 留在：

```text
apps/electron/**
```

避免对以下路径做永久性下游改动：

```text
apps/web/**
packages/**
```

除非它们是真正与上游兼容、并打算向上游贡献的改动。

# 第三部分 — TARGET 架构

## 17. 目标架构

**TARGET**

```text
                 Electron Runtime
                         │
             Desktop Capability Contract
                         │
                         ▼
┌─────────────────────────────────────────────────┐
│         Electron-owned Renderer                 │
│                                                 │
│ thin bootstrap / transport carrier              │
│                 │                               │
│                 ▼                               │
│              AppWebEntry                        │
│                 │                               │
│          DSH Client Runtime                     │
│                 │                               │
│      ┌──────────┼────────────┐                  │
│      ▼          ▼            ▼                  │
│ upstream    desktop       third-party           │
│ plugins     plugins       plugins               │
└─────────────────────────────────────────────────┘
                         │
                         ▼
                 Supervised DSH Host
```

目标稳态规则是：

> **Electron Runtime 保持精小且稳定；产品能力主要通过插件增长。**

## 18. Desktop Capability Contract

**TARGET**

`DeepseekDesktopBridge` 应演进为刻意维护的约定。

每项能力 MUST：

1. 描述用户／原生能力，而非 Electron 原语；
2. 暴露所需的最少操作；
3. 在特权代码中校验安全敏感参数；
4. 类型化；
5. 使用显式通道；
6. 定义失败行为；
7. 避免暴露原始 Electron/Node 对象；
8. 为订阅返回显式 disposer（资源释放）。

优先：

```text
desktop.dialog.pickDirectory()
desktop.notification.show(...)
desktop.shell.openExternal(...)
```

不要暴露：

```text
desktop.invoke("anything", payload)
desktop.electron.shell
desktop.rawIpc
```

## 19. 功能插件模型

**CURRENT**

下游插件按 runtime requirement 分属两处：

```text
apps/electron/runtime/plugins/
├─ desktop-capabilities/            Client composition root
│  └─ src/client/features/          directory-picker, brand, network-settings, plugin-manager
└─ desktop-network-subprocess/      independent Host provider

npm registry
├─ @dsh-electron/dsh-theme-studio  ecosystem plugin (dshElectron.ecosystemPlugins)
└─ @dsh-electron/dsh-plugin-*      ecosystem plugin (dshElectron.ecosystemPlugins)
```

架构规则：

* 功能代码仍由下游拥有；
* 功能集成使用 DSH/Cordis；
* Renderer bootstrap 不初始化每一项产品功能；
* 特权操作仍位于能力约定之后；
* 普通 Desktop 功能开发不需要修改上游。

插件分为四类：

### Portable DSH Plugin

```text
Plugin
  └─ only DSH capabilities
```

它可跨 Web 与 Desktop 工作。

### Desktop-aware DSH Plugin

```text
Plugin
  ├─ normal DSH behavior
  └─ optional native Desktop enhancement
```

尽可能优先渐进增强：

```text
Web
  -> normal feature

Desktop
  -> normal feature + approved native capability
```

主 fiber 只声明 portable requirements。缺少 `desktop` 时 optional `ctx.inject(['desktop'], ...)` child fiber 保持 pending；兼容 provider 出现时激活；provider 卸载时只释放 native enhancement。公共插件只声明实际使用的最小 structural `desktop` interface，绝不 import Electron provider。

### Desktop-required Adapter

Desktop-required Client adapter 是 `@dsh-electron/dsh-electron-desktop-capabilities` 的内部 Cordis feature。它 inject `desktop`，并从子 fiber 占用产品 slot。它不是独立的 `@dsh-electron/dsh-electron-*` Loader 包。Host-only provider（如 `@dsh-electron/dsh-electron-network-subprocess`）仍是独立的 `runtime/plugins/` 包和 overlay 行。

### 预装的 portable ecosystem 插件

用户拥有启用权的 portable `platform: web` 公共包可作为预装 ecosystem bundle。它只使用上游 DSH 服务，Desktop 安装、打包并链接其已发布 npm artifact，不重新构建。Theme Studio 与 Git 都声明在 `dshElectron.ecosystemPlugins` 中，用户可在共享 web profile 中禁用它们。

## 20. 原生实现与功能所有权

示例：Terminal。

```text
Terminal Feature Plugin
├─ UI
├─ tabs
├─ state
├─ commands
└─ DSH integration
        │
        ▼
native terminal/PTY capability
        │
        ▼
Electron Main
```

插件拥有产品行为。

Electron 拥有特权机制。

# 第四部分 — 里程碑

## 21. 里程碑 1 — 独立的 Electron Renderer

**Status: DONE**

目标：

> 停止使用 `apps/web` 作为 Electron 页面。

结果：

```text
Electron Renderer
    │
    ▼
@deepseek-ai/dsh-client-web
    │
    ▼
DSH client plugin graph
```

不要回退此里程碑。

## 22. 里程碑 2 — 原生 Desktop Capability 层

**Status: DONE**

目标：

> 把特权桌面行为移到 Electron Main 之后，并暴露窄的类型化能力。

已完成的领域包括：

```text
typed preload bridge
closed IPC channels
directory picker
clipboard
shell
notification
updater
theme
window controls
Renderer hardening
```

未来的 Renderer／插件代码 MUST NOT 绕过此边界。

## 23. 里程碑 3 — 插件化功能层

**Status: DONE**

目标：

> 建立可复用的模型：下游定制 UI 与独立 Desktop 产品功能以 DSH/Cordis 插件形式存在，同时 Electron 保持为稳定运行时。

已完成内容包括：

```text
generic runtime plugin builder (build-runtime-plugins.mjs)
generic bundled plugin discovery and linking (runtime-plugins.ts)
Desktop Capability Provider (ctx.desktop)
directory picker migrated to capability service
host.patch.yml explicit composition
architecture and regression tests
```

验收标准（已满足）：

开发者可在不修改 `apps/web`、上游核心包、`renderer/main.ts`、通用 IPC 或通用基础设施的情况下添加新的独立 Desktop Client 功能——在 `desktop-capabilities/src/client/features/` 下增加内部 feature。新的 Host-only provider 仍在 `runtime/plugins/` 增加目录，或在 `dshElectron.runtimePlugins` 中声明已发布 runtime 插件，并在 `host.patch.yml` 增加 Loader 行。

## 24. 可选里程碑 4 — 传输优化

**Status: DEFERRED / OPTIONAL**

此前把：

```text
Electron Main
  -> localhost HTTP/WebSocket
  -> dsh web
```

替换为自定义进程 IPC 载体的想法，不再是强制要求。

仅在存在证据时再考虑，例如：

```text
measurable performance problems
real port/network conflicts
security constraints
packaging reliability problems
upstream-supported non-Web transport
maintenance cost exceeding replacement cost
```

不要为了架构纯粹性替换成熟的上游传输。

# 第五部分 — 功能落点

## 25. 决策规则

若本质上需要 Electron/OS 特权：

> 把特权实现放在 Electron Core／Desktop Services。

若是独立产品功能或 UI 领域：

> 做成 DSH/Cordis 功能插件。

若是对所有 client 有用的通用 Harness 行为：

> 优先采用上游 DSH 能力，或做与上游兼容的贡献。

若是功能内部的小组件：

> 保持为普通组件／模块。

若 Desktop 专属 UI 看起来必须修改 `apps/web`：

> 停下来，围绕扩展点／插件重新设计。

## 26. 所有权示例

| 需求                        | 首选拥有者                              |
| --------------------------- | --------------------------------------- |
| 窗口生命周期                | Electron Core                           |
| 托盘／菜单                  | Electron Core                           |
| 更新器引擎                  | Electron Core                           |
| 安装程序／签名              | Electron/CI                             |
| 原生目录选择器              | Electron Capability                     |
| 目录选择器 UI               | DSH client 插件                         |
| 侧栏贡献                    | DSH client 插件                         |
| 设置功能                    | DSH client 插件                         |
| Git 体验                    | DSH 插件 + 可选原生能力                 |
| Terminal 体验               | DSH 插件 + provider／原生 seam          |
| Agent／会话／工具行为       | DSH/Cordis                              |
| 模型能力                    | DSH 插件／服务                          |
| Host 传输                   | Electron Runtime                        |
| 小型 React 组件             | 所属功能模块                            |

# 第六部分 — 反模式

## 27. 应避免的设计

不要在 `apps/electron/src/renderer` 中再建一套下游 `apps/web`。

不要散落：

```text
if (isElectron) { ... }
```

到上游包中。

不要暴露：

```text
window.deepseekDesktop.invoke(...)
ipcRenderer
```

不要允许插件 import Electron。

不要仅为审美一致性而把基础设施插件化。

不要在没有具体可测理由时替换上游 HTTP/WebSocket 传输。

不要为了实现仅下游的 UI 捷径而修改上游包。

# 第七部分 — 安全

## 28. 安全不变量

下列各项 MUST 始终成立：

1. Renderer 没有 Node 集成。
2. Renderer 使用上下文隔离。
3. 除非有文档化的安全决策改变此项，否则 Renderer 保持沙箱化。
4. BrowserWindow 保持在 Desktop 自定义源上。
5. 拒绝任意导航。
6. 外部 URL 经校验后通过 Main 打开。
7. 不暴露通用 IPC API。
8. 原生能力参数在特权代码中校验。
9. 插件接收能力，而非 Electron 对象。
10. 在使用 sidecar 传输期间，受监督 Host 保持仅环回。
11. 新的特权 API 需要显式的信任边界评审。

# 第八部分 — 状态所有权

## 29. Harness 状态

Harness 仍负责：

```text
profiles
settings
sessions
Harness plugin state
upstream credentials/storage
```

不要为这些概念创建并行的 Electron 自有副本。

## 30. Electron 状态

Electron 专属数据可放在 Electron `userData` 中，例如：

```text
Chromium data
desktop update preference
desktop runtime metadata
generated Host overlay copy
```

通用 Harness 状态不属于那里。

# 第九部分 — 文档与 Agent 规则

## 31. 文档职责

`apps/electron/README.md` 应保持为简洁的事实性入口，覆盖：

```text
what Desktop is
build/run/test
CURRENT runtime architecture
native integrations
updates/packaging
security
link to architecture guide
```

详细的下游架构文档应位于：

```text
docs/electron/architecture.md
```

`AGENTS.downstream.md` 应包含简洁、可执行的架构规则，并链接到详细文档。

它应明确告知 Agent：

```text
Desktop-only changes stay under apps/electron/** and docs/electron/**
Do not modify apps/web for Desktop-only UI
Do not modify upstream docs/** outside docs/electron/** for Desktop-only content
Keep Renderer bootstrap thin
Prefer plugins for independent features
Plugins must not import Electron
Native operations cross the typed capability contract
Do not replace loopback Host transport without justification
```

不要把本文完整副本写入 `AGENTS.downstream.md`。

## 32. Agent 工作流

在实现架构敏感的 Desktop 工作之前，Agent 应当：

1. 阅读 `AGENTS.md`；
2. 阅读 `AGENTS.downstream.md`；
3. 阅读本文档；
4. 检查当前 Electron 代码；
5. 将改动归类为 Electron Core、Desktop Capability、Feature Plugin、上游 Harness 改动，或构建／发布关切；
6. 选择最窄的所有权层；
7. 除非有正当理由，避免改动上游拥有的文件；
8. 为变更的边界补充测试；
9. 仅在行为已实现后更新 CURRENT 文档；
10. 仅在有明确架构决策后更新 TARGET 文档。

# 第十部分 — 架构评审

## 33. 评审清单

对于非平凡的 Desktop 改动，询问：

* 这是否真的属于 Electron Core？
* 既有的 DSH/Cordis seam 能否解决它？
* 这项独立功能是否应做成插件？
* `renderer/main.ts` 是否开始感知产品逻辑？
* 这是否把 Desktop-only 代码加进了 `apps/web` 或上游包？
* 这是否扩大了 IPC 特权？
* Renderer／插件代码现在能否获得更多 OS 权威？
* 这是否要求在 Renderer 中直接使用 Node/Electron？
* 这是否为 Harness 状态创造了第二真源？
* 这是否重复了上游传输／运行时行为？
* 这是否增加了未来上游同步冲突？
* CURRENT 与 TARGET 标注是否仍然准确？

# 第十一部分 — 架构决策

## ADR-DESKTOP-001 — Electron 仍是应用／运行时

**Decision：** 保持现有 Electron 应用模型，而不是把 Desktop 本身做成 DSH 插件。

**Reason：** 窗口生命周期、安全、打包、更新器、原生集成与进程监督是基础设施职责。

## ADR-DESKTOP-002 — 复用 DSH client 包，而非 `apps/web`

**Decision：** Desktop 拥有自己的 Renderer，并直接启动 `@deepseek-ai/dsh-client-web`。

**Reason：** 这在保持上游 client／插件兼容的同时，让 Desktop 拥有自己的源、bootstrap、安全与原生集成。

## ADR-DESKTOP-003 — 原生行为使用窄的类型化能力约定

**Decision：** Electron Main 拥有 OS 特权。

**Reason：** 特权面保持显式、类型化且可评审。

## ADR-DESKTOP-004 — 独立下游功能是插件

**Decision：** 新的定制产品 UI 与功能领域应优先采用 DSH/Cordis 插件。

**Reason：** 防止 Renderer 变成第二套单体前端，并最小化 fork 面。

## ADR-DESKTOP-005 — 保留受监督的 `dsh web` sidecar

**Decision：** 除非有证据支持替换，否则保留内部环回 Host 传输。

**Reason：** 它对 BrowserWindow 已经隐藏，并保持上游兼容。

## ADR-DESKTOP-006 — 插件化止于功能边界

**Decision：** 不追求「一切皆插件」。

**Reason：** 插件化独立的产品行为，而不是基础设施或微小实现组件。

# 第十二部分 — 最终方向

## 35. 长期方向

前两个里程碑建成了 Desktop 平台。

下一阶段不是又一次大规模的 Electron 重写。

开发问题从：

```text
How do we keep restructuring Electron?
```

变为：

```text
How do we add product capabilities cleanly
on top of a stable Electron Runtime?
```

最终的开发模型是：

```text
Upstream DeepSeek Harness
        │
        │ upstream sync
        ▼
DSH Core / Host / Client Runtime
        │
        ├──────────────────────────────┐
        │                              │
        ▼                              ▼
Upstream plugins                Downstream feature plugins
                                       │
                                       │ approved capability calls
                                       ▼
                             Desktop Capability Contract
                                       │
                                       ▼
                                Electron Runtime
                                       │
                                       ▼
                                  Operating System
```

目标终态是：

> **Electron Core 保持精薄、特权化且稳定。**
>
> **DeepSeek Harness 仍是应用核心。**
>
> **定制下游 UI 与产品能力主要通过插件增长。**
>
> **类型化的 Desktop Capability Contract 是插件与原生 OS 行为之间的受控桥梁。**
>
> **现有 Host sidecar 传输仍是内部兼容机制，直到有证据支持替换。**

除非后续架构决策明确取代它，这就是未来 Desktop 开发的默认方向。
