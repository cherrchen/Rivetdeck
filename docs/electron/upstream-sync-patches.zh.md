# 上游同步临时补丁

[English](upstream-sync-patches.md) | 中文

## 摘要

Rivetdeck 针对固定的 `dsh-v0.2.1-rc.5` 版本，临时修补两项上游 hygiene 检查。每次同步上游时都要逐项复核，并在上游实现首次通过下述检查的那次同步中移除相应补丁。这些是临时维护修复，不是永久的下游行为。

## 目录

- [临时补丁](#temporary-patches)
- [同步时撤销补丁](#retirement-during-synchronization)
- [开发备注](#dev-note)

<a id="temporary-patches"></a>

## 临时补丁

这两项问题属于上游检查代码；桌面打包产物在本机触发第二项问题。

| 补丁 | 本地修改 | 撤销前必须验证的上游行为 |
| --- | --- | --- |
| 在 vendor 改名时保留创造预设标识符 | [改名检查器](../../scripts/rescope-vendor.ts)及[测试](../../scripts/rescope-vendor.spec.ts)：新增 23 个文件的例外、这些文件中六处框架 import 的精确检查，以及可测试的改写辅助函数；[改名文档](../rescope.zh.md)及其双语记录 | 检查器保留代码、配置注释和文档中的预设标识符，同时拒绝真正未改 scope 的框架 import。没有这些本地新增内容时，检查仍能通过。 |
| 在源码配置发现中排除打包应用 | [配置发现](../../scripts/cordis-config-files.ts)及[测试](../../scripts/cordis-config-files.spec.ts)：排除根目录 `dist/`，并覆盖打包配置 | 排除根目录 `dist/` 下的打包配置副本，同时继续检查源码 Loader 配置。旧打包副本不能引起源码解析失败。 |

<a id="retirement-during-synchronization"></a>

## 同步时撤销补丁

逐项检查待同步的上游实现，并在不包含对应本地新增内容的情况下验证。版本变化或无冲突合并本身不能说明问题已修复。如果上游实现通过该行检查，就在同一次同步中移除本地实现、冗余的测试适配和重复文档。保留上游覆盖与仍需维护的下游回归覆盖。如果只修好一项，就只撤销该项；另一项继续保留，直到它自己的检查通过。

按补丁逐项移除修改，不要整体恢复文件。共享文件还包含其他下游修改，例如配置读取中的 Windows Git 符号链接处理和已有的改名修正。除非它们自己的撤销条件也已满足，否则必须保留。

撤销后运行受影响的检查器测试和完整 hygiene 检查。在这台 8 GiB 开发主机上，Node 默认堆不足以完成可选依赖 import 检查；已验证的完整检查命令为：

```sh
NODE_OPTIONS=--max-old-space-size=4096 DSH_GATE_CONCURRENCY=3 pnpm run hygiene
```

这些资源设置是本地验证参数，不是第三项源码补丁。每撤销一项，就从本文移除对应行。两项都撤销后，删除本文的双语文档及[下游指令](../../AGENTS.downstream.md#upstream-synchronization)中的入口链接。

<a id="dev-note"></a>

## 开发备注

无。
