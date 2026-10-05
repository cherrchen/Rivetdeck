# Electron 上游包审查

[English](upstream-package-audit.md) | 中文

## 摘要

本记录保存 2026-10-04 对 `feat/optional-managed-toolchains` 与上游标签 `dsh-v0.2.0-rc.2` 的审查，包含历史同步回归与相应归属决定。该标签是被审查分支的祖先；当前上游 master 不属于本次比较范围。这是一份审查记录，不表示历史 UI 已完全等价恢复。

## 目录

- [当前包差异](#current-package-differences)
- [历史同步发现](#historical-sync-findings)
- [验收证据](#acceptance-evidence)
- [维护](#maintenance)

<a id="current-package-differences"></a>

## 当前包差异

被审查分支最初在 20 个 `packages/` 文件中存在差异，共增加 120 行、删除 51 行。本次处理后，仅 `packages/client/ui-plugin-manager/` 的七个文件与固定标签不同：组件、store、对应的两个测试，以及 README 双语三件套。

| 功能 | 处理结果 | 是否需要更改共享包 |
| --- | --- | --- |
| 有效 bundle 元数据 | 共享 plugin-manager 实现与测试恢复为标签版本；Desktop 使用已有的 `DesktopPluginManager` 清单 | Electron 不需要：清单读取 `DesktopRuntime` 实际选择的包目录 |
| 卸载权限 | 保留下游 UI 修改贡献：Uninstall 遵循 `removable`；Enable/Disable 保持独立 | 当前追加操作的 slot 无法隐藏内置 Uninstall；需要共享补丁或替换整套 UI |
| 配置锁等待期限 | 共享 ConfigEditor 恢复为标签版本；Electron Host 在相同 Loader 行替换为 `DesktopConfigEditor` | 不需要：通过 builtin 服务提供者与 Host overlay 提供 Desktop 策略 |

设置 `installed = false` 不能等价实现卸载权限：这会同时将包移出 Installed 分组。保留的贡献维持清单可见性和启停操作，并遵循 Host 的卸载权限。[插件组合](plugin-lifecycle.zh.md#downstream-ui-contribution)拥有其维护策略。

Desktop 提供者继承上游配置读取，并自行负责写入事务，因为上游编辑事务没有暴露锁等待期限。它保留校验、YAML 保留、获取锁后重新读取、HMR 串行化、overlay 覆盖拒绝与协调失败回滚。每次事务仅获取一次写入锁，不在超时后重试整个编辑。默认获取锁等待 120000 ms；零表示立即尝试获取。该策略仅适用于配置编辑：`DesktopRuntime` 协调仍使用 atomic-write 默认期限。

<a id="historical-sync-findings"></a>

## 历史同步发现

| 历史修改 | 同步结果 | 当前处理 |
| --- | --- | --- |
| 公共生态插件路径与 Typert 服务排除，下游 #53 | subtree 时期的声明与排除项在 0.1.5-rc.2 集成后消失 | Git 与 Theme Studio 使用独立 npm 产物；旧被排除服务与通用 Details Host 均已不存在 |
| 安装产物预检，下游 #65 | 共享 `inspectBundlePackage` 预检消失 | Desktop 在链接前校验随包产物；范围小于原先对所有用户安装 bundle 的预检 |
| Git Details 标题对齐，下游 #83 | 上游替换 Details slot/layout 后，旧标题高度的发布者与消费者被移除 | Git 使用右侧栏 pane；旧通用 Details Host 与原先精确对齐行为未恢复 |
| 上游集成与 Git 侧栏恢复，下游 #92 | 集成期间旧 Details 消费者停止加载；Git 适配到右侧栏 | 确实发生过暂时回归，随后迁移插件；删除 subtree 不代表当前 Git 缺失 |
| 预取模块 transport guard | 上游重组模块加载 | 旧 guard 文本消失本身不能证明回归；加载由共享 loader 负责 |
| 运行时清单与卸载 UI，下游 #106 | 两项贡献均保留在后续 0.2.0-rc.2 合并中 | 清单现在由 Desktop 负责；卸载 UI 继续作为有文档记录的下游贡献 |

同步工作流遇到未解决的 `packages/` 冲突会停止。Git 无冲突合并不代表语义兼容。后续同步验收需要检查功能行为与仍有效的扩展点，不能仅检查旧代码是否存在。

<a id="acceptance-evidence"></a>

## 验收证据

所属测试加载实际安装的已发布 Git `0.2.4` Host 产物，在私有仓库执行发现、状态、stage、unstage、工作区及 index diff、commit、历史与分支操作。实际 Client factory 使用当前 primitive 依赖加载，并声明右侧栏服务，不要求 Desktop 或已删除的 Details 服务。这验证产物加载和可移植依赖声明，没有渲染三个 pane，也不证明视觉等价。

已发布 Theme Studio `0.1.3` Client factory 在其文档规定的 theme 与 settings 接口上执行预览、取消、应用与恢复默认。预览不写入 settings；应用与恢复会写入。这些测试不验证 Electron 重启后的跨进程持久化。

ownership 测试在共享 profile 中放置不同 Git 版本，验证 Desktop 仍报告随包版本、来源与卸载权限。运行时产物测试在写链接前拒绝缺失的随包输出。Desktop 配置测试覆盖超过共享两秒期限的争用、获取锁后重新读取、超时不写入、恢复继承值、校验拒绝、回滚与期限 schema 校验。共享 settings/plugin-manager 测试与保留的 UI 测试覆盖未改变的上游服务及卸载、启停行为。

本次审查没有执行完整 Electron GUI、Windows 安装程序、真实模型 session 或远程 Git 操作。旧通用 Details Host、旧对齐行为及完整用户安装预检仍是明确的历史差异，不能视为已验收等价。

<a id="maintenance"></a>

## 维护

架构测试将 `apps/cli` 与 `packages/boot` 对比固定标签，因此检查已提交差异与工作区差异。CI 与发布测试任务显式获取该上游标签，因为下游 origin 没有发布它。更改上游固定版本时，需要复核该比较及 Desktop 事务与新上游实现的差异。包管理依赖同步必须保留 Desktop ConfigEditor 依赖。当前配置与保留 UI 贡献策略参见[插件组合参考](plugin-lifecycle.zh.md)。
