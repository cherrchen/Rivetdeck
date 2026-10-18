# Session 数据 Checkpoint 与 Restore

[English](session-checkpoint-restore.md) | 中文

> 本文所述机制已在 `apps/electron/src/checkpoint/` 实现;[机制事实](#mechanism-facts)记录其所依托的上游行为。设计依据与待办事项归 [Agent Note](../../.agents/notes/implemented/feature/2026-10-18-session-checkpoint-restore.zh.md) 所有。

## Summary

Rivetdeck 与 CLI `dsh --profile web` 共享同一个 `$DSH_HOME`,因此新版 harness 写入的 session 可能让内置的旧版 Harness 无法读取。桌面端在每次经报告的干净退出后暂存 checkpoint,且只晋升通过内置 Harness 真实读取路径校验的 session;并提供按 session 的按需恢复——在该 session 自有写租约保护下以 journaled 事务实现。

## Contents

- [背景](#background)
- [机制事实](#mechanism-facts)
- [失败模式](#failure-modes)
- [设计](#design)
- [局限与风险](#limits-and-risks)
- [源码索引](#source-index)

<a id="background"></a>

## 背景

桌面应用监督一个跑在共享 `web` profile 上的 Harness Host:`apps/electron/src/main.ts` 从 `DSH_HOME` 或 `~/.dsh` 解析 `harnessHome`,`apps/electron/src/host.ts` 在 `$DSH_HOME/profiles/web` 启动该 profile。CLI `dsh --profile web` 打开的是同一个 home。两侧读写同一份 session 存储、profile 组合、settings、credentials 和 KV storages;只有 `$DSH_HOME/electron/` 是桌面端私有的。

因此新版 CLI 可能写入内置 Harness 读不了的数据。没有 checkpoint 时唯一的补救是在更新的主机上打开受影响的数据——这正是促成本机制的事故报告所记录的(dsh-plugin-git PR #20:`session.v4.jsonl.zstd` 内 seq 24 处的 `job/registered`)。[共享 Harness Home](shared-dsh-home.zh.md) 描述了当前面向用户的行为。

<a id="mechanism-facts"></a>

## 机制事实

**共享 home 布局。** Session 位于 `$DSH_HOME/sessions/<project-key>/<encoded-session-id>/`,由 `packages/bundle/base/cordis.patch.yml` 中的 `root: dshHomePath('sessions')` 配置,不属于任何 profile。受管理的 profile 文件集是 `package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`compatibility.json`,加上已安装的 `node_modules`(`packages/boot/plugin-manager`);home 根部的 `cordis.patch.yml` 在 profile patch 之上参与组合(`app-boot` 的 `profile-context.ts`)。当前 Settings 值写在 profile patch 内;home 的 `settings.yaml` 只是旧版的一次性导入源,首写后改名为 `settings.yaml.imported`。KV 域位于 `$DSH_HOME/storages/`;`$DSH_HOME/attachments/v1` 下的附件是 content-addressed 的。

**按代寻址的不可变日志。** 每个 Session 目录内,每个格式版本对应一个文件——v0 为 `session.jsonl.zstd`,后续代为 `session.vN.jsonl.zstd`(`packages/session/session-format/src/filename.ts`)。新版写入者迁移日志时发布后继文件,绝不改动已提交的前代。历史读取可能拉取关联 session:v3→v4 迁移会按 `header.parentSession` 收集 subagent 子代的 descriptor(`session-persistence-jsonl` 的 `catalog-migration.ts`),因此一个 session 的读取单位是该 session 加其关联源,而不是孤立的一个目录。

**准入规则。** `resolveGenerationInDirectory` 选择数值最高的 canonical 文件,不回退到更早的代(`packages/session/session-persistence-jsonl/src/index.ts`)。header 准入拒绝 `storedVersion > SESSION_FORMAT_VERSION`。事件准入(`packages/session/session-persistence/src/storage-contract.ts` 的 `validateStoredEvents`)拒绝 `KNOWN_SESSION_EVENT_TYPES` 之外、且信封未带 `ignorable: true` 的事件类型。列表会跳过 header 被拒的 session;事件准入只在打开 session 时运行,因此列表可见的 session 仍可能打不开。

**写租约,按平台区分。** 每个 Session 目录持有一个 `session.lock`,拒绝第二个并发写入者(`lease.ts` 的 `SessionAlreadyOwnedError`)。POSIX 上租约是绑定锁文件 inode 的 flock——跟随被 rename 的目录,因此替换目录会改变锁身份。Windows 上是 `Local\` 前缀、以 resolved path 哈希命名的 semaphore——inode 替换后仍然有效但不持有文件句柄,因此打开的句柄会让 rename 失败,而 semaphore 本身不提供读隔离。读取根本不取租约:header 读取与列表从不 acquire `session.lock`,因此外部读者可能观察到事务中途的 Session 目录。不存在 home 级的"harness 运行中"锁。

**关闭并不自我证明。** `apps/electron/src/main.ts` 的 `prepareToInstall` 通过 `stopHarness` 停止受监督的 Host(SIGTERM、5 秒宽限、再 SIGKILL,见 `harness/process.ts`),而 `stopHarness` 在强杀后与在干净退出后同样 resolve。Host 的 `createProcessShutdown`(`host.ts`)在 dispose 失败或超时后仍以调用方传入的码 force-exit,启动失败路径也会走到 `prepareToInstall`。在干净路径上,持久化后端的 teardown effect 关闭所有打开的 handle,close 即 drain 追加缓冲(`session-persistence-jsonl` 的 `storage.ts`)——但目前没有任何东西把这个 drain 结果报告回 Main。

<a id="failure-modes"></a>

## 失败模式

| # | 触发条件 | 磁盘结果 | 旧版 harness 中的症状 | 无 checkpoint 可否恢复? |
| - | ------- | -------- | --------------------- | ----------------------- |
| A | 新版 harness 格式版本更高并发布 `session.vN` | 新增后继文件;前代保留 | session 从列表中静默消失 | 可——挪走新文件即可读前代,但看不到迁移后的事件 |
| B | 新版 harness 版本相同但写入旧 build 不认识的事件类型 | 已提交的当前代文件被就地污染 | session 仍在列表中;打开时历史加载失败(`SessionFormatUnsupportedError` → `SESSION_QUERY_PERSISTENCE_FAILED`) | 否——不存在 pre-image |
| C | 新版 harness 改动共享 profile 组合 | `cordis.patch.yml` / `package.json` / `compatibility.json` / `node_modules` 漂移 | Host 可能在任何 session 打开前就启动失败 | 视情况 |

模式 B 就是已报告的事故:`0.2.1-alpha.3` 把 `job/registered` 和 `job/settled` 作为必需(非 ignorable)事件加入 `KNOWN_SESSION_EVENT_TYPES`,而 `SESSION_FORMAT_VERSION` 仍是 4,于是旧 build 读取同一个 `session.v4.jsonl.zstd` 时拒绝整个日志。模式 B 也是唯一一种 checkpoint 是唯一补救手段的情形:磁盘上没有未受影响的文件可以恢复。

<a id="design"></a>

## 设计

**Checkpoint 节奏与晋升。** checkpoint 候选在一次*经报告的*干净 drain(见下)之后,暂存到 `$DSH_HOME/electron/checkpoints/<timestamp>.tmp/`,再 rename 提交。晋升是 per-session 的:每个复制出的 session——连同其关联源闭包——必须通过内置 Harness 真实读取路径的校验(解压、header 准入、事件准入,以及含关联源读取的历史迁移路径),在独立子进程中以只读、可取消方式执行,绝不在 Main 中同步执行,也绝不走可能发布结果的 write-open。新副本校验失败的 session 保留其上一份已验证副本;由于这使同一 checkpoint 内混入不同捕获时刻的数据,候选提交前要对合并后的关联源闭包整体重校一次。验证与校验者绑定:应用升级或降级后,存量的"已验证"标记不继承,因此副本在恢复时还要用当前 build 再校一遍。保留策略保护每个 session 的最后一份已验证副本;按时间的轮换只用于限制总空间。

**Shutdown 报告。** `stopHarness` resolve 只能证明子进程没了。Host 必须发出显式的 shutdown 报告——到达 ready 加上 drain/dispose 结果,与退出码相互独立——Main 同时记录 signal、timeout、kill 与退出结果。晋升要求报告成功且 per-session 校验通过;启动失败或打开失败后的 relaunch 绝不晋升,因为该路径带着磁盘上的问题状态也会走到 `prepareToInstall`。v1 固定保守规则:无法确认的 run 一律不晋升;强杀 run 中校验通过的文件是否可晋升留作后续讨论。

**Manifest。** `manifest.json` 记录 checkpoint 标识、shutdown 报告结果、复制时刻的每文件源状态 `{path, size, mtimeNs}`、绑定实际复制字节的每文件摘要 `{size, hash}`,以及每 session 的 `{dir, header, capturedAt, sourceCheckpointId, validator}`——其中 `header` 是存储的 session header(推导关联源闭包并在续做时重新获取写租约),validator 是验证该副本的应用版本与 `SESSION_FORMAT_VERSION`。stat-diff 用 live 文件对照记录的源状态——它只是扫描提示,能发现外部写入,既不能证明写入者身份也不能证明副本完整;摘要守护副本本身;per-session 时间戳让确认页在一个 checkpoint 混入不同退出时刻的数据时仍然诚实。

**覆盖集。** `sessions/`(必需)、`profiles/web/{cordis.yml,cordis.patch.yml,package.json,pnpm-workspace.yaml,pnpm-lock.yaml,compatibility.json}`(v1 纳入备份;恢复范围见下)、home 根部 `cordis.patch.yml`、`storages/session_projcache*`(随 session 回滚)、`.env`(小,防御性)。排除:`session.lock`、`session.migration.*.tmp`、`storages/*.lock`(瞬时)、`attachments/`、`cache/`(content-addressed 或可再生)、`node_modules`(由 profile 恢复事务重建)、credentials 与 identity 文件、`settings.yaml*`(仅旧版导入),以及 `electron/` 自身。checkpoint 副本是冷归档,绝不作为活动 harness 存储挂载。

**检测。** 三层:(1) 启动时,manifest stat-diff 加上 `session.vN` 文件名扫描(N 大于内置版本,模式 A);命中项再经晋升所用的同一只读校验确认后才提示,因为兼容的外部写入也会漂移。(2) 打开时,`SessionFormatUnsupportedError` 现场提示恢复——这是覆盖漏过检测的就地污染的唯一信号。(3) 一个手动菜单/托盘入口;本地 Host 存活时,候选会话还须证明 `session.lock` 写租约空闲,进行中的追加读取才不会被当成不可读。大目录扫描声明预算与取消行为;staging 前检查磁盘余量;quarantine 目录保留全部被替换字节,v1 不做自动清理——是否删除由用户决定,以外来分支换空间。

**恢复事务。** 恢复是 journaled、可续做的,并有明确的提交点。替换文件先以 `*.tmp` 名暂存在目标目录内并完成同步再发布:canonical 的 `session[.vN].jsonl.zstd` 名只承载完整文件,因为跨目录移动一律是 rename,拷贝先落临时名。事务通过后端租约机制 acquire 该 session 的 `session.lock`,在动任何 live 文件之前持久化 journal(目标 session、checkpoint 代、阶段、前状态文件指纹),然后把 live 代文件 rename 进 quarantine、把 staged 文件 rename 为 canonical 名——每个中间集合都保持可连贯选择,因为读取器只选最高 canonical 代且 canonical 名永远不是半成品。journal 的 commit(文件与目录同步)发生在释放租约*之前*。finalize 仍是 journaled 工作:失效所恢复 session 的 `session_projcache` 行——连同其关联源闭包的行——在切换之后运行,但必须幂等地完成,之后才允许删除 journal、才允许下一次拉起 Host;残留的已提交 journal 绝不重做(文件切换不重复),但一定会做完。"无其他 Harness"前提覆盖整个事务而不只是切换:从恢复开始直到 finalize 持久完成,其他实例必须保持退出——外部写入恢复后日志的合法窗口在 journal 删除之后才开启,否则在 commit 与 finalize 之间启动的外部 Host 仍会加载陈旧缓存行。残留 journal 的续做要重新建立前提,而不是沿用上次确认:它处在同样的拉起 Host 之前的生命周期点并重新获取租约;未提交的 journal 另按记录的指纹复核 live 文件——中断期间外部写入者追加过数据则停止并向用户报告冲突而不是覆盖。持久性顺序:切换意图先持久化,再修改文件;文件及目录同步完成后记录 `committed`;缓存失效持久完成后记录 `finalized`,最后删除 journal——Windows 上采用后端的 write-through 发布先例,因为 `syncDirectory` 在那里是 no-op。quarantine 与 checkpoint 与 `sessions/` 同处 `$DSH_HOME` 卷,保证 rename 原子;跨设备 home 退化为 copy-verify-unlink 并由 journal 在续做时去重。本地 Host 在场时确认的恢复无法就地执行,意图持久化到 `electron/pending-restore.json`,在 relaunch 之后、与 journal 收敛相同的拉起 Host 前窗口内执行;每个排队请求只在其尝试结束后才移除。

**并发。** 恢复通过后端租约机制 acquire 目标 session 的 `session.lock`——acquire 成功即证明无活写入者,锁竞争则干净拒绝,持有整个切换期间锁,关闭"先探测再移动"的竞态窗口。切换在保留的目录与锁文件内部替换文件,两个平台上锁身份都不变。没有已验证 checkpoint 副本的 session 一律拒绝恢复并原位保留——v1 不移动无法替换的 live 数据;若将来另设独立 quarantine 功能,需要独立的互斥设计。读取者以两个层次位于租约保证之外。较浅一层:读打开不取租约,外部读者在切换中途可能看到暂时缺失或部分的代集合,需重试;内置 Harness 在恢复期间从不读取,因为 Host 尚未启动或正在 relaunch。较深一层:外部 Host 持有恢复前日志的内存投影,且其 `coldSnapshot` 写回是 fire-and-forget——在恢复前取走旧日志的读者可能在我们的失效之后才写回,复活一条陈旧的 `session_projcache` 行,而缓存身份(`formatVersion`、`createdAt`、`cwd`、`inheritedEventCount`)无法把回滚后的日志与被污染的后继区分开。租约和删行都挡不住,因此 v1 把一条本就存在的前提硬化:从切换开始到 finalize 持久化的整个窗口内,恢复只在没有其他 Harness 实例存活时执行——写入者可经租约检出,读者不留痕迹,确认页要求其他 `dsh`/Rivetdeck 实例在该时段内保持退出,且本地 Host 在场时恢复入口拒绝执行。在 `CheckpointIdentity` 中加入缓存 epoch、让陈旧写回被拒绝,是 post-v1 的上游改动。Windows 的路径派生 semaphore 不能当作 rename 隔离——它不持有文件句柄。

**Profile 恢复独立且属 post-v1。** Profile 作用于所有 session,不能随单个 session 隐式回滚。其恢复是独立事务:上述受管理文件集加 home patch,在共享 profile 写锁(`withFileLock(package.json)` 先例)下应用,依赖重建通过内置包管理器遵守 `pnpm-lock.yaml`——现有 `prepareCoreProfile` 在 `package.json` 存在时直接返回,不能充当该路径——安装失败时回退,包括已被安装过程改过的 `node_modules` 树。v1 备份这些文件,但不宣称覆盖模式 C。

**恢复范围如实说明。** 恢复一个 session 不会恢复周围的世界:workspace 文件、外部工具副作用、覆盖集外的插件存储保持较新状态,持久 schedule 仍可能向恢复后的 session 投递。确认 UI 要写明 checkpoint 时间、将被隐藏的数据范围、quarantine 位置与这些限制;恢复后首次启动能否立即执行后台任务在 Agent Note 中留作待办。

**需要传达的语义。** 恢复是回滚,不是合并。新版 harness 写入的事件对内置 build 不可见(换回 quarantine 可恢复);如果内置 build 随后写这个回滚过的 session,历史就永久分叉——格式设计上没有从后继代回退到前代的路径。

<a id="limits-and-risks"></a>

## 局限与风险

1. 回滚而非合并——见上文语义段;两个写入者会让一个 session 永久分叉。
2. checkpoint 必须先于污染存在;已中招的 session 没有 pre-image。
3. 桌面端运行期间的并发外部写入,只有 per-session 校验能挡住才不晋升;校验是承重闸门,stat-diff 不是。
4. 覆盖集是白名单;未来 `$DSH_HOME` 新增的状态类型需要跟进 manifest。
5. 租约只约束遵守它的写入者;恢复途中的外部读者可能看到暂时的部分集合、需要重试——可接受,因为外部读与文件级维护赛跑在今天已可能存在。违例进程的在途 `coldSnapshot` 写回,仍可能在一次未满足"无其他 Harness"前提的恢复之后重新污染 `session_projcache`——堵住这条路径的是前提,不是租约。
6. 范围只覆盖桌面应用链路;纯 CLI 用户遇到同样错位时此机制无解——上游"插件侧无法修复"的结论不变。
7. stat-diff 会标出任何外部写入,包括完全兼容的;检测中的解析确认步骤保证弹窗精确。
8. 崩溃或强退不晋升任何内容;上一份已验证 checkpoint 仍在,因此一次恢复可能丢掉整轮 session 增量。

<a id="source-index"></a>

## 源码索引

- `apps/electron/src/checkpoint/` — checkpoint/restore 实现(capture、manifest、校验 worker、journal、restore、检测、pending 队列、拒读帧、确认对话框)
- `packages/session/session-persistence-jsonl/src/index.ts` — 代选择(`resolveGenerationInDirectory`)、header 准入(`readGenerationHeader`)、列表(`listArtifacts`)、关联源接线(`parentSession`)
- `packages/session/session-persistence/src/storage-contract.ts` — `validateStoredEvents` 事件准入
- `packages/session/session-format/src/filename.ts` — canonical 代文件名
- `packages/session/session-persistence-jsonl/src/lease.ts` 与 `win32.ts` — POSIX inode flock 与 Windows 路径派生 semaphore
- `packages/session/session-persistence-jsonl/src/storage.ts` — `flushAll` 与 teardown drain effect
- `packages/session/session-persistence-jsonl/src/generation.ts` — `syncDirectory`(仅 POSIX;Windows 走 write-through 发布)、迁移 staging
- `packages/session/session-persistence-jsonl/src/catalog-migration.ts` — 历史迁移期间的关联子代读取
- `packages/bundle/base/cordis.patch.yml` — `sessions` 与 `storages` root
- `packages/boot/app-boot/src/profile-context.ts` — home 根部 `cordis.patch.yml` 组合层
- `packages/boot/app-boot/src/profile-compatibility.ts` — `compatibility.json` 归属
- `packages/boot/plugin-manager` — 受管理的 profile 文件集
- `apps/electron/src/main.ts` — `prepareToInstall`、`startHarness`、`relaunchDesktop`、启动失败路径、菜单/托盘安装
- `apps/electron/src/harness/process.ts` — `stopHarness` 在强杀后同样 resolve
- `apps/electron/src/host.ts` — `createProcessShutdown`、`appReady` readiness 信号
- `apps/electron/src/host-profile.ts` — `$DSH_HOME/electron/` 桌面私有先例
- `apps/electron/src/ecosystem-profile.ts` — `prepareCoreProfile` 提前返回;不是重建路径
- `apps/electron/src/desktop-config-editor.ts` — 共享 profile 写锁先例
- `docs/electron/shared-dsh-home.zh.md` — 描述当今共享 home 行为的用户侧配套文档
