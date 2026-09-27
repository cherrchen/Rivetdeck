# Electron 插件组合

[English](plugin-lifecycle.md) | 中文

> 状态：**当前下游参考**
>
> 范围：`apps/electron/**`、`apps/electron/runtime/**`
>
> 读者：维护者、coding agent（编程智能体）、评审人与未来贡献者

## 目的

Desktop 挂载必需的 adapter 和随包 Git 插件，用户安装的插件由上游 Web profile 管理。

## 启动组合

`runtime/host.patch.yml` 挂载 Desktop Capability Provider、目录选择 client、品牌、网络设置、Theme Studio 和随包 Git 插件。Theme Studio 作为 `@dsh-electron/dsh-theme-studio@0.1.1` 从 npm 安装，并声明在 `dshElectron.runtimePlugins` 中；其已发布的 peer 声明包含 `0.1.7-rc.2`。Main 在启动 `dsh web` 前校验每个随包插件的 Host 和 Client 产物，并将 package 链接到 `$DSH_HOME/profiles/node_modules`。缺失产物会使启动报错。

上游 Web bundle 挂载自己的插件管理 UI 和 agent tool。Main 将随包 pnpm 加入受监督 Host 的 `PATH`，使上游 profile manager 无需全局安装 pnpm 即可执行 package 命令。升级后首次启动时，Main 将旧版 `$DSH_HOME/electron/plugin-state.json` 的 `profileManaged` 条目迁入 `$DSH_HOME/profiles/web/cordis.patch.yml`，并保留各条目的禁用状态。旧文件留作恢复依据；迁移标记防止用户后来移除的插件再次被加入。如果已安装包缺失，迁移会在 Host 启动前停止，旧文件和 patch 保留以供修复。迁移后，插件启用状态由 Web profile patch 管理。Electron 不再维护独立的实时插件状态文件或动态 Cordis include。

## 边界

`ctx.desktop` 向 Desktop-aware 插件提供操作系统能力，不包含插件管理组。Renderer 通过现有 Main transport 接收 Host 插件脚本和 RPC。Desktop Host overlay 静态列出随包插件；用户安装的 bundle 由上游 profile 组合。
