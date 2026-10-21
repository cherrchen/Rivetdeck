# Desktop 与 CLI 共享 Harness Home

[English](shared-dsh-home.md) | 中文

## Summary

Rivetdeck 与 CLI `dsh --profile web` 共享同一个 Harness home(`~/.dsh`),让两个应用共用一份 profile、一份 session 历史以及同一套插件和设置。当 CLI 比内置 Harness 更新时,它写入的 session 可能在应用内无法读取。本页描述当前的共享内容、版本错位的症状,以及目前可用的应对办法。

## Contents

- [共享内容](#what-is-shared)
- [典型用法](#typical-usage)
- [版本不一致时](#when-versions-differ)
- [目前可以怎么做](#what-you-can-do-today)
- [回滚路径](#rollback-path)

<a id="what-is-shared"></a>

## 共享内容

两个应用读写 `$DSH_HOME` 下的同一批文件(默认 `~/.dsh`,可通过 `DSH_HOME` 环境变量覆盖)。两者之间没有复制,它们操作的是同一份存储。

| 路径 | 内容 | 对你的意义 |
| ---- | ---- | ---------- |
| `sessions/` | 全部 Session 日志,按项目目录分组 | 应用的侧栏和 CLI 里出现同一份会话历史 |
| `profiles/web/` | 共享 profile 的组合:`cordis.patch.yml`(含当前 Settings 值)、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`compatibility.json`、已安装插件。home 根部 `cordis.patch.yml` 在其上参与组合 | 插件装一次、组合改一次,两个应用都生效 |
| `storages/` | 共享 KV 数据,如 session 列表缓存与 workspace 状态 | 两个应用看到同一份派生状态 |
| `attachments/` | session 引用的 content-addressed 图片和文件 | 附件在任一侧打开 session 时都可用 |
| `.credentials.yaml`、`.env` | provider 凭据与环境变量 | 配置一次,两侧通用 |
| `settings.yaml`、`settings.yaml.imported` | 旧版 Settings 文件,一次性导入 profile patch 后改名 | 仅历史——当前 Settings 值写在 profile patch 内 |
| `electron/` | 桌面端私有状态(host profile 投影、插件状态) | 不共享;CLI 忽略它 |

<a id="typical-usage"></a>

## 典型用法

你可以开着桌面应用做 GUI 操作,同时在同一台机器的终端里跑 `dsh --profile web`。一侧开的 session 会出现在另一侧,任意一侧都可以继续它。一侧做的插件安装、profile 修改和 settings 变更,重启后对另一侧可见。

两个应用可以同时运行。每个 session 一个写锁(各 Session 目录里的 `session.lock`)阻止两个写入者同时编辑同一 session——第二个写入者会被 `SessionAlreadyOwnedError` 拒绝。该锁只保护并发写,分辨不了 harness 版本。POSIX 上该锁是绑定 inode 的 flock,跟随被 rename 的目录;Windows 上是以 resolved path 派生的命名 semaphore,目录替换后仍然有效,而打开的句柄会让 rename 失败。

<a id="when-versions-differ"></a>

## 版本不一致时

兼容性是单向的。新版 harness 通过迁移目录读取更旧的 Session 日志,并在写入时发布一个后继代。旧版 harness 从不回退:它总是选最新的代文件,并拒绝解释不了的内容。

| 新版 harness 做了什么 | 你在旧版应用里看到什么 |
| --------------------- | ---------------------- |
| 为某 session 发布了更新的格式文件(`session.vN`) | 该 session 从会话列表里静默消失 |
| 在同一格式版本下写入了内置 build 不认识的事件类型 | 该 session 仍在列表中,但打开时历史加载失败,报错指出未知事件类型 |
| 改动了共享 profile 组合 | 应用可能在任何 session 打开前就启动失败 |

已报告的案例:`dsh ≥ 0.2.1-alpha.3` 写入的 session 含有 `job/registered` 事件,`0.2.1-alpha.2` 及更早的 build 不认识该事件,两边格式版本同为 4。在旧版上打开该 session 会报 `contains event type "job/registered" ... unknown to this harness`。

<a id="what-you-can-do-today"></a>

## 目前可以怎么做

- 用较新的工具打开受影响的 session。数据完好,只是旧版 build 拒绝读取。
- 让 CLI 与应用内置 Harness 保持版本一致,使任何一方都不会写出另一方读不了的数据。
- 应用开着的时候,避免同时用新版 CLI 写同一批 session——并发的外部写入可能落进应用正在使用的 session 里。
- 手动把 `session.vN` 文件挪开可以在格式版本情形下露出前代,但这不受支持:它只是隐藏了较新的事件而非调和它们,而且当污染位于共享的当前代文件内部时也无能为力。

<a id="rollback-path"></a>

## 回滚路径

应用内置一套 checkpoint/restore 机制:每次经报告的干净退出后,快照内置 Harness 验证可读 session 数据;新版 harness 写入不兼容数据后,可通过"恢复会话…"菜单或启动提示把单个 session 回滚到最近一次已验证副本。见 [Session 数据 Checkpoint 与 Restore](session-checkpoint-restore.zh.md)。
