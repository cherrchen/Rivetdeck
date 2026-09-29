# Agent Note: Electron ecosystem 的 runtime ownership 是进程本地的

Status: implemented

[English](2026-09-29-electron-process-local-ecosystem-runtime-ownership.md) | 中文

## Problem

Desktop 每次启动都将 `dshElectron.ecosystemPlugins` 链接进共享的 `$DSH_HOME/profiles/node_modules` 与 `profiles/web/node_modules`。这使 Electron 拥有了 profile package 持久化，导致 `dsh plugin --profile web list` 可能与 Host runtime 不一致，并发 CLI `dsh web` 也可能导入 Desktop 随包副本。required runtime 插件仍需要 Desktop 拥有的共享链接；ecosystem 插件不得如此。

本下游改动不能在上游 `packages/boot/app-boot` 中加入仅 Desktop 使用的 override。Desktop 必须在不改写共享 profile package 的前提下保持进程本地的 runtime ownership。

## Decision

拆分三条 ownership 轴：

- **Persistence** 仍属于共享 web profile（`package.json`、lock、`node_modules`）。共享的 `dsh plugin` 操作首次预装缺失包并修复旧版 Desktop 链接；manifest、lockfile 和包目录均由该操作写入。用户移除后保持移除状态。
- **Activation** 仍属于 `dsh.profile.bundles`。Disable 对 CLI 与 Desktop 同时生效；Desktop 不得重新挂载已禁用的 ecosystem 插件。
- **Runtime implementation** 是进程本地的。CLI 解析 profile 安装副本。受监督 Desktop Host 通过 `apps/electron/src/host.ts` 启动，构建 `$DSH_HOME/electron/host-profile`（位于 `profiles/` 之外），转发普通 web 包，并将 ecosystem 名称指向 Electron 随包目录。`ProfileContext.dir` 仍指向共享 web profile，供 Plugin Manager 与已安装版本列表使用。

`ensureRuntimePluginsLinked` 只链接 required runtime 插件。ownership overlay 继续抑制重复 Cordis 行，不负责选择物理 package 来源。存在已应用的 Host 投影层时，ecosystem 规范 id 来自该层。

未来上游 app-boot 的 `RuntimePackageOverride` 可替换该私有投影；在此之前 Desktop 将投影保留在 `$DSH_HOME/electron/host-profile`。

本决策更新 [Electron profile-managed ecosystem and ownership overlay](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.zh.md) 中的 profile 预装和文件系统 ownership。该笔记中的 Enable/Disable 与 overlay 去重仍然有效。

## Alternatives considered

**全局改为 profile-first 的 `resolveBundleDir`。** 否决，因为 in-box bundle 必须保持 installation-owned。

**启动时备份并在退出时恢复共享 package。** 否决，因为 crash、kill 与并发 CLI 竞争会使磁盘状态错误。

**用 `NODE_PATH` 或环境级 package takeover。** 否决，因为 agent 子进程会继承 Desktop ownership。

**把 ecosystem 插件提升为 required runtime 插件。** 否决，因为用户应在 Installed 组拥有 Enable/Disable。

**在本下游 PR 中修改 `packages/boot/app-boot`。** 按 AGENTS.downstream.md 否决；Desktop-only 工作留在 `apps/electron/**` 与 `docs/electron/**`。

## Consequences

CLI 与 Desktop 可对同一 web profile 并发运行，并使用不同的 ecosystem package 目录。`dsh plugin list` 继续报告 profile 安装版本。Desktop 退出无需恢复共享 profile。新的非 ecosystem 安装可能需要重启 Host 后私有投影才会转发它们，这与上游的 restart-required 情形一致。开发模式下 install-anchor 查找仍可能优先用 profile 包提供 patch，而模块来自 Host 投影；打包后的 Desktop 则使二者都落在 Electron 副本上。
