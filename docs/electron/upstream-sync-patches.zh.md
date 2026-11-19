# 上游同步临时补丁

[English](upstream-sync-patches.md) | 中文

## 摘要

Rivetdeck 针对固定的 `dsh-v0.2.2-rc.5` 版本，临时修补两项上游 hygiene 检查。每次同步上游时都要逐项复核，并在上游实现首次通过下述检查的那次同步中移除相应补丁。这些是临时维护修复，不是永久的下游行为。

上一次同步退役了 vendor 改名补丁：新的检查器只改模块 import，并保留已有记录的 preset 标识符，因此本地例外以及描述它们的两条文档条目已一并删除。上游在该 tag 发布后修复了它仍然漏掉的三个文件；本仓库把这项修复提前带到固定版本之前，即下表中的补丁。

## 目录

- [临时补丁](#temporary-patches)
- [同步期间的退役](#retirement-during-synchronization)
- [开发备注](#dev-note)

<a id="temporary-patches"></a>

## 临时补丁

两项问题都出在上游检查代码中；打包后的 Desktop 产物会在本地暴露第二项问题。

| 补丁 | 本地改动 | 退役所需的上游行为 |
| --- | --- | --- |
| 保留 tag 版改名校验漏掉的 Creator preset 标识符 | [改名校验器](../../scripts/rescope-vendor.ts)与[测试](../../scripts/rescope-vendor.spec.ts)：为 `apps/web/tests/creator-persona.e2e.ts` 和两份 `subagent-interrupt-default` 升级指南文件补上 `GENERIC_SKIPS` 条目，移植自 tag 之后发布的上游修复 | 校验器覆盖每个把 `cordis` 写作 preset 标识符的文件，同时仍然改写框架 import，并且 `pnpm run rescope-vendor:check` 在上游原始工作树上通过。 |
| 从源码配置发现中排除打包产物 | [配置发现](../../scripts/cordis-config-files.ts)与[测试](../../scripts/cordis-config-files.spec.ts)：排除根目录 `dist/` 并覆盖打包配置 | 根目录 `dist/` 下的打包配置副本被排除，源码 Loader 配置仍受检查；旧打包副本不得导致源码解析失败。 |

<a id="retirement-during-synchronization"></a>

## 同步期间的退役

对每个补丁，检查新传入的上游实现，并在去掉对应本地改动后测试它。仅凭版本变化或无障碍合并不能证明问题已修复。若上游实现通过该行的检查，就在同一次同步中删除本地实现、冗余的测试适配与重复文档。保留上游覆盖率以及仍然需要的下游回归覆盖。若只修复了其中一项，只退役该项补丁，另一项保留到其自身检查通过为止。

按补丁删除改动，不要整文件回退。共享文件还包含其他下游改动，包括配置读取中的 Windows Git 符号链接处理与既有的改名校验修正。除非其自身的退役条件达成，否则保留这些改动。

退役后运行受影响的校验器测试与完整的 hygiene 聚合。在 8 GiB 开发主机上，默认 Node 堆不足以完成可选依赖导入检查；已验证的聚合调用是：

```sh
NODE_OPTIONS=--max-old-space-size=4096 DSH_GATE_CONCURRENCY=3 pnpm run hygiene
```

这些资源设置是本地验证参数，不是第三个源码补丁。每退役一行就从本参考中删除该行。当两行都退役后，删除这份双语参考及其在[下游说明](../../AGENTS.downstream.md#upstream-synchronization)中的链接。

<a id="dev-note"></a>

## 开发备注

无。
