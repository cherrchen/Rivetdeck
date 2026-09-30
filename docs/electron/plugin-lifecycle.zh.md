# Electron 插件组合

[English](plugin-lifecycle.md) | 中文

> 状态：**当前下游参考**
>
> 范围：`apps/electron/**`、`apps/electron/runtime/**`
>
> 读者：维护者、coding agent（编程智能体）、评审人与未来贡献者

## 目的

Desktop 将 Electron-owned 包与普通 profile-owned 插件组合运行。共享 web profile 拥有包持久化与用户启停意图。Electron Installed 展示有效的 ecosystem 与 profile bundle 清单，包含已禁用的包，并使用实际解析的包元数据与 Loader/Fiber 状态。

## 插件类别

**Profile-managed。** `dsh plugin` 与 Plugins 页通过上游包操作写入 `$DSH_HOME/profiles/web`。不属于 Electron 声明 owned set 的普通第三方 bundle 参与 Electron 组合，并解析到 profile 包。外部 CLI add、remove、update 操作触发实时协调；删除该包会卸载其 Loader 条目，并移除 Installed 卡片。

**Desktop-required。** `runtime/plugins/` 目录、`dshElectron.runtimePlugins` 中的包，以及 overlay 必需 adapter（含 `directory-picker-browse`）属于应用组合。Electron overlay 始终挂载它们。这些插件不能关闭，也不会单独显示为 Installed 卡片。它们的 Loader 行仍可通过插件清单读取。

Desktop-required 不等于每个包一张 Official 卡。四件事分开：composition package、internal feature、独立 Host adapter、以及 portable runtime / ecosystem 插件。

**Composition package。** `@dsh-electron/dsh-electron-desktop-capabilities` 是一个 Loader/npm 包，只有一个 `lib/client.js`。它提供 `ctx.desktop`，并通过 Cordis `ctx.plugin()` 挂载内部 feature。它不是 `immediately: true`；`ctx.desktop` 随 application batch 激活。

**Internal features。** 目录选择、品牌、网络设置与 plugin-manager 位于 `desktop-capabilities/src/client/features/`。它们是带有自己的 `name` / `inject` / `apply` 的子 fiber，不是 Loader 行，也不是 npm 包。

**Independent Host adapters。** `desktop-network-subprocess` 与上游 `directory-picker-browse` 仍是各自的 Loader 行。网络子进程保持 Host-only provider。

**Portable runtime / ecosystem。** Theme Studio 与 Git 都是 Installed 分组中的 ecosystem bundle。Theme Studio 发布包自带 Client UI；Desktop Capabilities 不代它注册。

Plugins 页仅由 composition package 为 Desktop Capabilities 注册 Official `plugins.item` 卡片。Desktop Capabilities 详情页显示版本、桌面能力标签、包名和一句说明，再以组合包「包含的组件」同样的标题与计数列出产品 Components（网络访问、系统文件夹窗口、选择工作文件夹、应用图标和名称、网络设置）。Capabilities 每一行显示这句说明、短 id 和包名：内部 feature 为 `@dsh-electron/dsh-electron-desktop-capabilities/<feature>`，独立 Loader adapter 用各自的 npm 名。Loader 行的运行状态来自 Host `pluginInventory/list`；directory-picker、brand、network-settings 来自 Client feature fiber。Capabilities 条目不能 Enable、Disable 或 Uninstall。

**Desktop-preinstalled ecosystem。** Desktop 首次启动时，共享的 `dsh plugin` 包操作按随包精确版本安装 `dshElectron.ecosystemPlugins` 中缺失的包（Git 与 Theme Studio）。该操作负责 web profile 的 manifest、lockfile 与已安装包；新 bundle 默认启用。已有 dependency 的版本和 Disable 选择保持不变。预装完成记录在 profile 外，因此之后 Uninstall 会移除共享安装，Desktop 不会重新安装。该包操作还会修复旧版 Desktop 留下的 ecosystem 链接。CLI `dsh web` 只加载 profile 安装副本。受监督 Desktop Host 通过 `$DSH_HOME/electron/host-profile` 加载 Electron 随包副本；profile 卸载后，仅其私有 bundle 列表继续启用随包副本。已安装但被 Disable 的 bundle 在两个宿主中均保持禁用。Installed 展示随包运行时版本与来源，独立于 CLI/profile 副本。Electron-owned 包不能从应用中卸载；CLI 删除只影响 profile 持久化。即使 profile 已删除该包，仍可通过指向随包 Loader 行的 profile patch 执行 Enable/Disable。

## 启动组合

启动顺序为：迁移旧版插件状态；发现并校验随包产物；将 required runtime 插件链接进共享 profile resolution；通过 `dsh plugin` 执行首次 ecosystem 预装和旧链接修复；物化 Host profile 投影；写出按 ownership 去重的 Host overlay；以该 overlay 启动 Desktop Host 入口。包操作失败时，Desktop 启动会显示诊断并停止。

共享包操作持有 web profile 的 `package.json` 写入锁，并更新其 manifest 与 lockfile。Desktop 的预装标记位于 `$DSH_HOME/electron` 下。

每次 Electron 启动仅为 **required runtime 插件** 恢复 `$DSH_HOME/profiles/node_modules` 与 `$DSH_HOME/profiles/web/node_modules` 下的 Desktop-owned 链接。ecosystem 包不再被 symlink 进这些共享树。`$DSH_HOME/electron/host-profile` 下的 Host resolution 投影转发普通 web 包，将 ecosystem 名称指向 Electron 随包目录，并只在该 Host 进程中选择已从 profile 卸载的 ecosystem 名称。Desktop 退出后共享 web profile 保持不变，无需 restore。

`DesktopRuntime` 拥有启动与后续组合代次。Desktop Capabilities 在现有 HMR 队列上注册共享 profile manifest、lockfile、启停 patch、兼容性文件与 home patch 的 watcher。协调在 CLI/包操作释放 profile 写入锁后获取该锁，刷新私有投影，卸载已删除或替换的包条目，使包查询缓存失效，并等待 Loader 稳定。上游 HMR profile reader 被隔离，避免从持久化目录重新组合。私有目录只包含可丢弃的投影文件，没有另一份包数据库或 lockfile。对每个 required 包，overlay 之前的每一行都被禁用，再由静态 overlay 插入 Desktop 行。对已启用的 ecosystem 包，保留已应用 bundle 层自身的行，禁用额外同名行。对已禁用的 ecosystem 包，额外同名行仍会被禁用。overlay 不插入 Git 或 Theme Studio。找不到的 id 走 include 已有警告，Main 不失败。

Theme Studio 作为 `@dsh-electron/dsh-theme-studio@0.1.3` 从 npm 安装，并声明在 `dshElectron.ecosystemPlugins` 中；其已发布的 peer 声明包含 `0.1.7-rc.2`。缺失随包产物会使启动报错。

上游 Web bundle 挂载自己的插件管理 UI 和 agent tool。Main 将随包 pnpm 加入受监督 Host 的 `PATH`，使上游 profile manager 无需全局安装 pnpm 即可执行 package 命令。升级后首次启动时，Main 将旧版 `$DSH_HOME/electron/plugin-state.json` 的 `profileManaged` 条目迁入 `$DSH_HOME/profiles/web/cordis.patch.yml`，并保留各条目的禁用状态。旧文件留作恢复依据；迁移标记防止用户后来移除的插件再次被加入。如果已安装包缺失，迁移会在 Host 启动前停止，旧文件和 patch 保留以供修复。

## 边界

`ctx.desktop` 向 Desktop-aware 插件提供操作系统能力，不包含插件管理组。Renderer 通过现有 Main transport 接收 Host 插件脚本和 RPC。Desktop Host 禁用上游 manager Loader 行，并以显式 builtin 插入 `DesktopPluginManager`。它保留指向 `ProfileContext.dir = web` 的上游包操作，报告有效包版本与本地化来源标签，并将 bundle 声明对应到真实 Loader 条目。共享 UI 遵循 Host 的删除权限。`$DSH_HOME/electron/runtime-inventory.json` 支持诊断记录实际解析的包与模块路径、版本、来源、启停及 Loader/Fiber 状态；它们是观测结果，不是配置。
