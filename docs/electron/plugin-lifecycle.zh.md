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

**Desktop-required。** `runtime/plugins/` 目录、`dshElectron.runtimePlugins` 中的包，以及 overlay 必需 adapter（含 `directory-picker-browse` 与 Theme Studio）属于应用组合。Electron overlay 始终挂载它们。这些插件不能关闭。

Desktop-required 不等于每个包一张 Official 卡。四件事分开：composition package、internal feature、独立 Host adapter、以及 portable runtime / ecosystem 插件。

**Composition package。** `@dsh-electron/dsh-electron-desktop-capabilities` 是一个 Loader/npm 包，只有一个 `lib/client.js`。它提供 `ctx.desktop`，并通过 Cordis `ctx.plugin()` 挂载内部 feature。它不是 `immediately: true`；`ctx.desktop` 随 application batch 激活。

**Internal features。** 目录选择、品牌、网络设置与 plugin-manager 位于 `desktop-capabilities/src/client/features/`。它们是带有自己的 `name` / `inject` / `apply` 的子 fiber，不是 Loader 行，也不是 npm 包。

**Independent Host adapters。** `desktop-network-subprocess` 与上游 `directory-picker-browse` 仍是各自的 Loader 行。网络子进程保持 Host-only provider。

**Portable runtime / ecosystem。** Theme Studio 是带有自己 Official 卡的必需 npm runtime 插件。Git 是 Installed 分组中的 ecosystem bundle。

Plugins 页仅为 Desktop Capabilities 与 Theme Studio 注册 Official `plugins.item` 卡片，文案为 Built into Desktop / Required by Desktop。Capabilities 详情页以组合包「包含的组件」同样的标题与计数列出产品 Components（网络子进程、目录选择后端、目录选择、品牌、网络设置）。Loader 行的运行状态来自 Host `pluginInventory/list`；directory-picker、brand、network-settings 的运行状态来自 Client feature fiber。条目不能 Enable、Disable 或 Uninstall。

**Desktop-preinstalled ecosystem。** `dshElectron.ecosystemPlugins` 中的包（当前为 Git）写入 web profile 的 pinned `dependencies`，并在首次 seed 时写入 `dsh.profile.bundles`。它们出现在 Installed/Bundle 卡片中，而不是 Official/`plugins.item`。Enable 与 Disable 持久保存在 `dsh.profile.bundles`。Uninstall 会去掉 dependency；下次 Desktop 启动会再次 seed 并默认启用。Git 是 portable bundle，同一 `$DSH_HOME` 下 CLI `dsh web` 也会看到它。

## 启动组合

启动顺序为：迁移旧版插件状态；发现 Desktop-owned inventory；校验随包产物；seed ecosystem 依赖（新 dependency 默认启用，已有 dependency 保留 bundle 选择）；恢复 Desktop-owned package 链接；加载 Electron overlay 之前的组合（bundle 层、`profiles/web/cordis.patch.yml`、然后 `$DSH_HOME/cordis.patch.yml`）；写出按 ownership 去重的 overlay；以 `dsh web --patch electron-host.patch.yml` 启动。

每次 Electron 启动都会把 Desktop-owned package 链接恢复到 `$DSH_HOME/profiles/node_modules` 与 `$DSH_HOME/profiles/web/node_modules` 下的应用内副本。会话内 Plugins 页执行 `pnpm add/remove/install` 重建 `node_modules` 后，要到下次启动才会再次修复。

ownership overlay 的扫描顺序与 `readProfilePatches()` 去掉 `--patch` 和 telemetry 之前一致。缺失的 web profile 或 home patch 当作空层，不会让启动失败。对每个 required 包，pre-Electron 中的每一行都被禁用，再由静态 overlay 插入唯一的 Desktop canonical 行。对已启用的 ecosystem 包，保留该包自己的 `dsh.bundle.patch` 插入行，并禁用 user patch 或 home patch 中的额外同名行。对已禁用的 ecosystem 包，overlay 不插入该包，canonical bundle 层因不在 `dsh.profile.bundles` 中而不出现，额外同名行仍被禁用。overlay **永不**插入 Git。找不到的 id 走 include 已有警告，Main 不失败。

Theme Studio 作为 `@dsh-electron/dsh-theme-studio@0.1.1` 从 npm 安装，并声明在 `dshElectron.runtimePlugins` 中；其已发布的 peer 声明包含 `0.1.7-rc.2`。缺失随包产物会使启动报错。

上游 Web bundle 挂载自己的插件管理 UI 和 agent tool。Main 将随包 pnpm 加入受监督 Host 的 `PATH`，使上游 profile manager 无需全局安装 pnpm 即可执行 package 命令。升级后首次启动时，Main 将旧版 `$DSH_HOME/electron/plugin-state.json` 的 `profileManaged` 条目迁入 `$DSH_HOME/profiles/web/cordis.patch.yml`，并保留各条目的禁用状态。旧文件留作恢复依据；迁移标记防止用户后来移除的插件再次被加入。如果已安装包缺失，迁移会在 Host 启动前停止，旧文件和 patch 保留以供修复。

## 边界

`ctx.desktop` 向 Desktop-aware 插件提供操作系统能力，不包含插件管理组。Renderer 通过现有 Main transport 接收 Host 插件脚本和 RPC。Electron 不为 ecosystem 插件隐藏 Uninstall，也不向上游 Plugin Manager 增加 `locked` 或 `source=desktop` 字段。
