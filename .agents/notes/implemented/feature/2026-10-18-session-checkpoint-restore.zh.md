# Agent Note: Desktop session checkpoint 与 journaled restore

Status: implemented

[English](2026-10-18-session-checkpoint-restore.md) | 中文

## Problem

Rivetdeck 与 CLI `dsh --profile web` 共享同一个 `$DSH_HOME`,因此新版 CLI 写入的 session 数据可能让内置 Harness 无法读取。一种失败模式是发布更高世代的文件,旧文件保持完整;另一种——已报告的事故,即 dsh-plugin-git PR #20 中 `session.v4.jsonl.zstd` seq 24 处的 `job/registered`——就地污染共享的当前世代文件,没有未受触碰的副本可以暴露。对第二种模式,此前唯一的补救是在更新的主机上打开数据。

## Decision

Desktop 在每次经报告的干净 Host drain 之后暂存一个 checkpoint 候选,且只晋升在只读 worker 子进程中通过内置 Harness 真实读取路径校验的 session。新副本校验失败的 session 保留其先前已验证副本并带入候选;混合了不同捕获时间的候选在提交前对合并后的关联源闭包再次校验。按 session 的恢复是在该 session 自有 `session.lock` 写租约下执行的 journaled 事务:live 文件先取指纹再移入隔离区,checkpoint 字节以规范文件名发布,遗留 journal 在下一次 Host 启动前收敛——当外部写入者持有成员租约时推迟并以启动弹窗呈现,当中断期间 live 文件漂移时以 conflicted 停止。进入恢复有三个入口:经同一只读校验确认的启动漂移检测、打开时的 `SessionFormatUnsupportedError` 提示,以及手动菜单项。

机制契约见 [docs/electron/session-checkpoint-restore.zh.md](../../../../docs/electron/session-checkpoint-restore.zh.md)。覆盖集为 sessions、受管理的 profile 文件集、home 根 patch、`session_projcache` storages 与 `.env`;credentials、identity、attachments、`node_modules` 与临时锁文件排除在外。恢复粒度为单个 session 及其关联源闭包;profile 回滚是独立事务,不在本范围。保留策略只约束总空间——每个 session 的最后一份已验证副本受保护。被杀死或不可验证的运行产生的文件一律不晋升。

## Alternatives considered

**Desktop 私有 sessions root。** 一行 overlay 即可让 Desktop 免于版本错位,但 Desktop 与 CLI 不再共享 session 历史,违背共享 home 的前提。

**启动时扫过并隐藏高世代文件。** 只覆盖新文件模式;就地污染位于共享的当前世代文件内部,清扫会静默截断可见历史。

**sanitize-fork:解码、丢弃未知事件、写出新 session 副本。** 被丢弃的事件可能留下悬空引用且需要重编 seq,无法提供安全保证。它仍是一种可能的恢复工具,而非主路径。

**让内置 Harness 与 CLI 保持版本一致。** 这是运营手段而非机制;只要 CLI 先行,错位就会复发。

**不做任何处理。** 与上游结论一致,但对就地污染模式而言——其不存在前像——事故的唯一补救仍停留在"在更新的主机上打开"。

## Consequences

恢复是回滚,不是合并。checkpoint 必须先于污染存在——已受影响的 session 没有前像。按 session 的校验是承重的闸门;stat-diff 只是扫描提示,也会标记完全兼容的外部写入。崩溃或强退不晋升任何内容,因此一次恢复可能丢弃整轮运行的 session 增量。写租约只保护遵守它的写入者,因此恢复还要求经确认的无其它 Harness 前提贯穿 switch 与 finalize;一个无法检测的外部 reader 的在途 `coldSnapshot` 回写仍可重新污染 `session_projcache`,这是记录在案的非保证项。遭遇同样版本错位的纯 CLI 用户在此没有补救途径。

## Testing

`apps/electron/tests/checkpoint-acceptance.spec.ts` 固定了故障注入与真实后端用例:两次污染退出间的 carry-forward、真实 `session.lock` 竞争、各 switch 阶段的 read-open、各阶段中断后的 resume、未知事件与更高世代的恢复,以及 quarantine 换回后的分支保全。`checkpoint-restore.spec.ts` 覆盖 journal 状态机与各类拒绝;`checkpoint.spec.ts` 覆盖捕获、晋升闸门与校验 worker 的结果帧;`checkpoint-detect.spec.ts` 覆盖漂移检测与无检查点时的如实拒绝。

## Deferred

- 是否需要为没有已验证副本的 session 提供单独确认的隔离区功能;v1 拒绝并保持 live 数据原样。
- 恢复后的首次启动能否立即对已恢复状态运行定时或后台任务。
- 前提之外的缓存一致性:`CheckpointIdentity` epoch 或等价的上游改动可以让陈旧的 `session_projcache` 回写被拒绝,而不必依赖进程缺席。
- Profile 与依赖恢复,包括按 `pnpm-lock.yaml` 重建与安装失败回退;v1 备份受管理文件集但不宣称覆盖。
