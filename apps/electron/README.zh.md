# DeepSeek Harness Desktop

[English](README.md) | 中文

此应用将上游 DeepSeek Harness 封装为原生桌面壳。Electron Main 在环回端口上监督已构建的 `dsh web` 后端以保持兼容，而 `BrowserWindow` 加载本包内基于 `@deepseek-ai/dsh-client-web` 构建的 Electron 自有 Renderer（`dsh-electron://localhost/`）。Host bootstrap、插件 bundle、一元 Host 调用（包括插件自有的 Connection RPC channel）与事件流仅通过 Main（类型化 preload IPC 与自定义协议代理）到达受监督进程。profile、会话与 `$DSH_HOME` 存储仍遵循上游 Harness 行为。

CURRENT 与 TARGET 架构、所有权规则、里程碑与 ADR 详见 [../../docs/electron/architecture.zh.md](../../docs/electron/architecture.zh.md)。

## 架构（CURRENT）

Desktop 分离三层：

| 层级 | 职责 |
| ---- | ---- |
| Electron Runtime | 窗口/托盘/菜单/更新器、OS 特权、安全策略、Host 进程监督、打包 |
| DeepSeek Harness | Agent、会话、工具、模型、profile、Cordis Host/Client 运行时、持久化 |
| Feature plugins | 以标准 DSH 插件封装的 portable 或 Desktop-aware 产品功能 |

进程拓扑：

```text
BrowserWindow (dsh-electron://localhost)
  └─ Electron-owned Renderer → @deepseek-ai/dsh-client-web
Electron Main
  ├─ typed window.deepseekDesktop bridge (no generic IPC)
  └─ supervised `dsh web` on 127.0.0.1:<random-port>
```

贡献者约束：

- Desktop 专属改动留在 `apps/electron/**`；不要通过改 `apps/web` 做 Desktop-only UI。
- 保持 `src/renderer` 为薄 bootstrap/carrier；不要在此长出第二套产品前端。
- Portable 与 Desktop-aware 产品功能归属独立发布的 DSH/Cordis package；`runtime/plugins/` 容纳 Desktop Capabilities composition 包与 Host-only provider。Desktop 必需的 Host 组合列在 `runtime/host.patch.yml` 中；随包 Git 与 Theme Studio 被 seed 进 web profile（[插件生命周期](../../docs/electron/plugin-lifecycle.zh.md)）。
- Desktop-aware feature 保持 core fiber portable，并通过 optional `ctx.inject(['desktop'], ...)` child fiber 安装原生增强。它通过 `ctx.desktop` 能力服务消费原生能力，不得直接访问 `window.deepseekDesktop`。
- 环回 Host 传输是内部兼容机制，无证据时不要为架构纯粹性替换它。

## 开发

使用仓库声明的 Node.js 与 pnpm 版本。启动 Electron 前先构建上游运行时：

```sh
pnpm install
pnpm run build
pnpm --filter @dsh-electron/dsh-electron start
```

`pnpm --filter @dsh-electron/dsh-electron build` 会编译主进程、preload 桥接、bundled runtime 插件与 Renderer（`dist/renderer`）。聚焦桌面测试需要这些 Electron 产物（在上方上游 `pnpm run build` 之后）：

```sh
pnpm --filter @dsh-electron/dsh-electron build
pnpm --filter @dsh-electron/dsh-electron test
pnpm --filter @dsh-electron/dsh-electron test:ownership
```

Electron 应用是私有安装程序，不作为 npm 发布成员。依赖同步使用 `workspace:^` 复制上游 CLI 的 workspace 依赖，排除实验性 peer 依赖，并保留可选 bundle 所需的稳定 peer 依赖；仓库的 `constraints` 检查对该应用执行此范围要求，并继续对上游包执行上游发布规则。

仓库的 Python 集成测试要求 PATH 中的 `python3` 指向 CPython 3.10+。若 mise 提示 shim 未激活，可为命令激活已安装版本，例如 `mise exec python@3.13.12 -- pnpm test packages/experimental/code-runtime-python/tests/runtime.spec.ts packages/experimental/code-runtime-python/tests/boot-write-failure.spec.ts`。请使用本机已安装的版本；运行测试前，`python3 --version` 必须成功。

独立的 [Network Runtime](../../docs/electron/network-runtime.zh.md) 为 Manual HTTP、HTTPS、SOCKS5 和严格 System 策略路由提供环回 Gateway。验证命令及接入限制见该文档。
[网络设置指南](../../docs/electron/network-settings.zh.md) 介绍设置页面、连接测试、安全存储提示及诊断信息。

## 桌面集成

主窗口使用隐藏标题栏，不绘制独立 Heading。侧栏背景延伸至窗口顶部：macOS 在侧栏顶部保留可拖拽的“交通信号灯”区域，Windows 和 Linux 则把侧栏右侧的各列下移到原生控件行之下，使该区域留空并可拖拽；全屏右侧面板会在自身盒内保留同样的留白行。活动会话 Header 的非交互部分可拖拽，空白会话背景与留空区域由透明命中面覆盖。Header 控件被明确排除拖拽；模态对话框打开期间，页面的所有拖拽区域均会暂停，使对话框遮罩和控件能够保持指针输入。关闭主窗口会隐藏窗口，Harness 进程继续运行。通过托盘菜单可以重新打开窗口，也可以退出应用并停止受监管的子进程。

操作系统桌面能力由 Electron Main 拥有，并通过类型化的 `window.deepseekDesktop` preload 桥暴露。Desktop Capabilities 包（`runtime/plugins/desktop-capabilities`）将该桥适配为 `ctx.desktop`、挂载 Desktop Client feature，并在 profile HMR 时刷新 Host ownership overlay。受监督 Host 接收生成的 `electron-host.patch.yml`，其中挂载必需的 Desktop Loader 行。启动时 Main 校验随包构建产物，将 required runtime 插件链接至 `$DSH_HOME/profiles/node_modules` 与 `$DSH_HOME/profiles/web/node_modules`，通过共享的 dsh plugin 包操作首次预装 Git 与 Theme Studio 等缺失的 ecosystem bundle，并修复旧版 Desktop 链接，并物化 `$DSH_HOME/electron/host-profile`，使 Host 将 ecosystem 包解析到 Electron 随包副本而不改写共享 profile package。Main 会将旧版由 Desktop 管理的运行时插件一次性迁入 Web profile patch，并保留其启用或禁用状态。共享 web profile 拥有包持久化；DesktopRuntime 拥有混合运行时组合与实时 CLI 协调，DesktopPluginManager 为上游“已安装”列表提供有效的 ecosystem 与 profile bundle；必需的桌面组件显示在“官方 → 桌面能力”中；Main 将随包 pnpm 加入 Host 的 `PATH`。`scripts/build-runtime-plugins.mjs` 从源码构建本地 Desktop 插件，Theme Studio 与 Git 则使用已发布的 Host 和 Client 产物。上游 UI 的剪贴板写入通过 Renderer shim 到达 Main。以新窗口打开的外部 URL 使用 `https:`、`http:` 或 `mailto:`。

随包提供的 Desktop 网络子进程插件在运行时导入已安装的 `dsh-subprocess-local` 和 `dsh-subprocess` 包。它们必须与 Host 共用“找不到可执行文件”的错误类，终端 shell 发现流程才能跳过未安装的候选项。

原生页面右键菜单根据 Chromium 当前的编辑能力提供剪切、复制、粘贴、全选和刷新；开发构建还提供 DevTools。应用菜单和托盘菜单提供桌面端自有的“关于”窗口、更新通道选择和手动更新检查入口。

托盘使用从受版本控制的 `assets/tray/deepseek.svg`（LobeHub lobe-icons，MIT）栅格化的单色 DeepSeek 图形。`pnpm run build:tray` 会在 `build/tray/` 下生成各 DPI 的 PNG；Windows 和 Linux 在原生浅色主题下选择黑色图形、在深色主题下选择白色图形，并按主显示器缩放因子选取最近的打包像素尺寸，在 Electron 报告主题或 display-metrics 变化时刷新。macOS 使用预渲染的 template PNG，由操作系统控制菜单栏对比度。

“关于”窗口从此包的 manifest（元数据清单）读取仓库 URL，显示打包的图标和版本，并在系统浏览器中打开项目链接。其渲染进程在沙箱中运行，Content Security Policy 只允许内嵌样式和图标。

## 更新

打包构建默认使用 **Pre-Release** 通道，并将用户选择的通道持久化到 Electron 的用户数据目录。应用菜单和托盘菜单可以在两个通道间切换：**Pre-Release** 接收最新发布的 prerelease 或 stable release；**Stable / Release** 使用 GitHub 的最新正式 release，绝不选择 prerelease。通道选择读取 GitHub Release 元数据，识别 `v0.1.0-beta.1`、`v0.1.0-rc.3`、`v0.1.0` 等 tag；metadata 校验、语义版本比较、下载与安装仍由 `electron-updater` 负责。

菜单会显示检查状态和下载进度，更新准备完成后提供重启入口。手动检查会报告没有更新或已开始下载。检查失败时，完整错误写入主进程日志，对话框只显示网络与重试指引。

`electron-builder` 生成 `latest.yml`、`latest-mac.yml`、架构专用的 Linux 元数据和 blockmap。桌面 release 工作流在上传安装包时合并各架构的元数据，使同一个 GitHub Release 同时服务 x64 和 ARM64 客户端。macOS 自动更新安装要求已签名的包；仓库的未签名 CI 产物可验证元数据生成和更新发现，但可信分发前必须提供签名凭据。

## 打包

包元数据将产品名声明为 `DeepSeek Harness`，Electron 与 `electron-builder` 会将它用于开发环境界面、应用元数据、安装程序和可执行文件。打包后的元数据使用无 scope 的 `deepseek-harness-desktop` 应用名称，因此 updater 缓存目录不会从仅供 workspace 使用的 `@dsh-electron/dsh-electron` 名称派生。包配置在 Windows 上生成允许用户选择安装目录的向导式 NSIS 安装程序，并使用带退出码检查的 7-Zip 解压 ZIP 载荷，支持超过 Windows MAX_PATH 的包成员路径，并在解压失败时拒绝安装；在 macOS 上生成 DMG 和 ZIP 产物，在 Linux 上生成 AppImage 和 DEB 产物。生成的 NSIS include 保留 Windows 原生路径分隔符，确保安装程序与卸载程序编译都能解析文件路径。release 工作流使用 GitHub 托管的原生架构 runner，为 x64 和 ARM64 构建每一种格式；每个 Windows runner 都会在上传前安装已完成的产物，检查可执行文件、runtime 和两个快捷方式，并在全新用户数据、没有托管运行环境且 registry 不可达的条件下启动已安装应用，再卸载并上传。CI 构建未签名产物，因此仓库无需配置签名凭据；需要分发可信二进制文件的维护者必须提供 `electron-builder` 支持的平台签名环境。

桌面 release 在 `develop` 上使用 `v{a.b.c}-beta.{x}`，在 `main` 上使用 `v{a.b.c}-rc.{x}`，稳定版使用 `v{a.b.c}`。[`sync-upstream.yml`](../../.github/workflows/sync-upstream.yml) 将上游合并到 `develop`，准备并推送下一个 Beta commit，仅在 Desktop CI 针对该提交成功后发布其 tag。开发者在创建 `develop` 到 `main` 的发布 PR（Pull Request）前，先运行 `pnpm electron:set-version <apps/cli version>`，再运行 `pnpm install --no-frozen-lockfile`，然后提交 Electron manifest 和 lockfile。Desktop CI 会拒绝来自其他分支、使用 Beta 版本或版本与 [`apps/cli/package.json`](../cli/package.json) 不一致的发布 PR。PR 合并后，[`desktop-promote.yml`](../../.github/workflows/desktop-promote.yml) 在已准备好的 `main` 提交上创建 RC 或 Stable tag，不修改任何分支。[`desktop-release.yml`](../../.github/workflows/desktop-release.yml) 在发布安装包前校验 tag 所在分支与 package 版本。

## 运行时与安全

Electron Main 在 Host 启动前加载版本化 Desktop preferences。Network 基础在 partial write 期间保留更新通道，对无效 Network section 使用默认值且不丢弃有效通道，通过 `safeStorage` 加密 Manual 代理密码，拒绝 Linux `basic_text` 持久化，消费一次性 Default override，并集中派生 Default、Direct、Managed child 和选择启用的 Agent 环境。Default 不修改继承的子进程环境或 Electron 代理配置。

在 macOS 上，启动时将钥匙串存储报告为受支持，但不访问钥匙串。保存 Manual 代理密码，或为当前 Manual 路由读取已配置的密码时，应用会检查存储可用性，此时可能请求钥匙串访问权限。密码文件不存在时不访问钥匙串。

Release 资源在固定的应用自有路径中包含 Rust Network Runtime。Manual 和 System 在 Harness 启动前启动并配置其 Gateway；Direct 显式设置 Electron 路由并清理受控子进程的代理变量。Default 不修改 Electron 代理设置和继承的子进程环境。关闭 Agent 代理后，Agent subprocess provider 保留继承的代理变量和 Harness home `.env` 中的代理值。Updater、插件命令及 Agent subprocess provider 各自遵循 Desktop 网络策略；支持的协议和当前限制见 [Network Runtime](../../docs/electron/network-runtime.zh.md)。

受监督的 Harness 进程仅绑定 `127.0.0.1` 上的随机端口，且永远不是 BrowserWindow 的页面源。Renderer 无 Node.js 集成，启用上下文隔离与 Chromium 沙箱，仅接收类型化的 `window.deepseekDesktop` 桥接，且不能离开 `dsh-electron://localhost`。以新窗口请求的 HTTP/HTTPS 链接在系统浏览器中打开。

Windows 上受监督进程是随包发布的 Node.js 运行时（`resources/core-runtime/node.exe`），以 `windowsHide` 和一个继承的 stdin 设备句柄启动，因此它持有一个隐藏控制台，`pwsh`、`git`、`cmd` 等 agent shell 命令会继承该控制台，而不会打开 Windows Terminal 窗口；其它平台使用 Electron 的 Node 兼容子模式。

Desktop Core 在 macOS/Linux 使用 Electron，在 Windows 使用仅包含 `node.exe` 和许可证的控制台执行器。Host 与插件包管理器使用 Core 执行器，不依赖可选 Agent 运行环境。Node.js 与 Python 通过可选初始化对话框或设置 → 网络与运行环境，分别安装到 Electron `userData/managed-toolchains` 下的版本化 generation。跳过状态独立于安装状态持久保存。Agent PATH 依次搜索请求、项目、用户和 Main 原始环境，最后才使用托管 fallback；显式删除 PATH 保持删除语义。仅已安装环境生成对应 shim。安装、更新和移除在重启后生效，保护运行中的任务。存储、网络与迁移行为见[运行环境](../../docs/electron/runtime-environments.zh.md)。

运行环境下载使用固定 HTTPS 归档及 [`toolchains.lock.json`](toolchains.lock.json) 中的 SHA256。Main 与构建准备流程共享安全解压实现，在原子激活前验证解释器版本、npm/npx、Python import 和 pip。发布准备使用 `prepare:core`；完整托管运行环境不进入安装包资源。

Main 保留显式 `$DSH_HOME`；否则受监督进程使用操作系统用户主目录下的 `.dsh`，因此 Harness profile、设置、会话等状态在 macOS/Linux 使用 `~/.dsh`，在 Windows 使用 `%USERPROFILE%\.dsh`。Electron 将 Chromium 数据、缓存与桌面更新偏好保留在其平台专属 `userData` 目录。Agent shell 命令以当前用户主目录为初始工作区；用户可通过 Harness UI 选择其他工作区。

Host 启动超时后，Desktop 会先停止受监督的子进程，再报告故障。上游 profile manager 拥有 package 事务和 profile 文件。
