# Electron 插件组合

[English](plugin-lifecycle.md) | 中文

> 状态：**当前下游参考**
>
> 范围：`apps/electron/**`、`apps/electron/runtime/**`
>
> 读者：维护者、coding agent（编程智能体）、评审人与未来贡献者

## 目的

Desktop 按谁拥有启用权来分类插件。Profile-managed 插件走上游 Plugin Manager。Desktop-required 插件是应用的一部分。Desktop-preinstalled ecosystem 插件随包默认启用，并仍可在 Installed 分组中开关。

## 插件类别

**Profile-managed。** `dsh plugin` 与官方 Plugins 页只是同一 web profile 的不同入口，最终都写入 `$DSH_HOME/profiles/web`。安装、启用、禁用与卸载由上游 Plugin Manager 完整管理。

**Desktop-required。** `runtime/plugins/` 目录、`dshElectron.runtimePlugins` 中的包，以及 overlay 必需 adapter（含 `directory-picker-browse`）属于应用组合。Electron overlay 始终挂载它们。这些插件不能关闭。

Desktop-required 不等于每个包一张 Official 卡。四件事分开：composition package、internal feature、独立 Host adapter、以及 portable runtime / ecosystem 插件。

**Composition package。** `@dsh-electron/dsh-electron-desktop-capabilities` 是一个 Loader/npm 包，只有一个 `lib/client.js`。它提供 `ctx.desktop`，并通过 Cordis `ctx.plugin()` 挂载内部 feature。它不是 `immediately: true`；`ctx.desktop` 随 application batch 激活。

**Internal features。** 目录选择、品牌、网络设置与 plugin-manager 位于 `desktop-capabilities/src/client/features/`。它们是带有自己的 `name` / `inject` / `apply` 的子 fiber，不是 Loader 行，也不是 npm 包。

**Independent Host adapters。** `desktop-network-subprocess` 与上游 `directory-picker-browse` 仍是各自的 Loader 行。网络子进程保持 Host-only provider。

**Portable runtime / ecosystem。** Theme Studio 与 Git 都是 Installed 分组中的 ecosystem bundle。Theme Studio 发布包自带 Client UI；Desktop Capabilities 不代它注册。

Plugins 页仅由 composition package 为 Desktop Capabilities 注册 Official `plugins.item` 卡片。Desktop Capabilities 详情页显示版本、桌面能力标签、包名和一句说明，再以组合包「包含的组件」同样的标题与计数列出产品 Components（网络访问、系统文件夹窗口、选择工作文件夹、应用图标和名称、网络设置）。Capabilities 每一行显示这句说明、短 id 和包名：内部 feature 为 `@dsh-electron/dsh-electron-desktop-capabilities/<feature>`，独立 Loader adapter 用各自的 npm 名。Loader 行的运行状态来自 Host `pluginInventory/list`；directory-picker、brand、network-settings 来自 Client feature fiber。Capabilities 条目不能 Enable、Disable 或 Uninstall。

**Desktop-preinstalled ecosystem。** Desktop 首次启动时，共享的 `dsh plugin` 包操作按随包精确版本安装 `dshElectron.ecosystemPlugins` 中缺失的包（Git 与 Theme Studio）。该操作负责 web profile 的 manifest、lockfile 与已安装包；新 bundle 默认启用。已有 dependency 的版本和 Disable 选择保持不变。预装完成记录在 profile 外，因此之后 Uninstall 会移除共享安装，Desktop 不会重新安装。该包操作还会修复旧版 Desktop 留下的 ecosystem 链接。CLI `dsh web` 只加载 profile 安装副本。受监督 Desktop Host 通过 `$DSH_HOME/electron/host-profile` 加载 Electron 随包副本；profile 卸载后，仅其私有 bundle 列表继续启用随包副本。已安装但被 Disable 的 bundle 在两个宿主中均保持禁用。Installed 卡片在 profile 有安装时显示其安装版本。

## 启动组合

启动顺序为：迁移旧版插件状态；发现并校验随包产物；将 required runtime 插件链接进共享 profile resolution；通过 `dsh plugin` 执行首次 ecosystem 预装和旧链接修复；物化 Host profile 投影；写出按 ownership 去重的 Host overlay；以该 overlay 启动 Desktop Host 入口。包操作失败时，Desktop 启动会显示诊断并停止。

共享包操作持有 web profile 的 `package.json` 写入锁，并更新其 manifest 与 lockfile。Desktop 的预装标记位于 `$DSH_HOME/electron` 下。

每次 Electron 启动仅为 **required runtime 插件** 恢复 `$DSH_HOME/profiles/node_modules` 与 `$DSH_HOME/profiles/web/node_modules` 下的 Desktop-owned 链接。ecosystem 包不再被 symlink 进这些共享树。`$DSH_HOME/electron/host-profile` 下的 Host resolution 投影转发普通 web 包，将 ecosystem 名称指向 Electron 随包目录，并只在该 Host 进程中选择已从 profile 卸载的 ecosystem 名称。Desktop 退出后共享 web profile 保持不变，无需 restore。

Desktop Capabilities 的 Host half 在 profile HMR 每次重新组合时都会刷新 ownership overlay。对每个 required 包，overlay 之前的每一行都被禁用，再由静态 overlay 插入 Desktop 行。对已启用的 ecosystem 包，保留已应用 bundle 层自身的行，禁用额外同名行。对已禁用的 ecosystem 包，额外同名行仍会被禁用。overlay 不插入 Git 或 Theme Studio。找不到的 id 走 include 已有警告，Main 不失败。

Theme Studio 作为 `@dsh-electron/dsh-theme-studio@0.1.2` 从 npm 安装，并声明在 `dshElectron.ecosystemPlugins` 中；其已发布的 peer 声明包含 `0.1.7-rc.2`。缺失随包产物会使启动报错。

上游 Web bundle 挂载自己的插件管理 UI 和 agent tool。Main 将随包 pnpm 加入受监督 Host 的 `PATH`，使上游 profile manager 无需全局安装 pnpm 即可执行 package 命令。升级后首次启动时，Main 将旧版 `$DSH_HOME/electron/plugin-state.json` 的 `profileManaged` 条目迁入 `$DSH_HOME/profiles/web/cordis.patch.yml`，并保留各条目的禁用状态。旧文件留作恢复依据；迁移标记防止用户后来移除的插件再次被加入。如果已安装包缺失，迁移会在 Host 启动前停止，旧文件和 patch 保留以供修复。

## 边界

`ctx.desktop` 向 Desktop-aware 插件提供操作系统能力，不包含插件管理组。Renderer 通过现有 Main transport 接收 Host 插件脚本和 RPC。Electron 不为 ecosystem 插件隐藏 Uninstall，也不向上游 Plugin Manager 增加 `locked` 或 `source=desktop` 字段。
