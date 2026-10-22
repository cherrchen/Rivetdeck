# Agent Note: Electron 卸载采用分层数据清理

Status: implemented

[English](2026-10-18-electron-uninstall-tiered-cleanup.md) | 中文

## 问题

原版 electron-builder NSIS 卸载器只删除 `$INSTDIR`，应用数据全部残留。下游的残留比一般 Electron 应用更重：`userData/managed-toolchains` 保存下载的 Node 与 Python 运行时，Chromium 缓存可增长到数百 MB，更新器缓存保存已下载的安装包。但整个删除 `userData` 根也并非无代价——其中有手动代理配置（代理用户在重新下载运行时之前需要它）、`network-secrets/` 中仍可用的加密凭据，以及承载真实用户状态（如未发送草稿）的持久化浏览器存储。共享的 Harness home（`$DSH_HOME`）绝不能删除，而 `userData` 与 `DSH_HOME` 又都可重定位（`--user-data-dir`、临时环境变量），因此只信任自身进程环境的卸载器无法证明应用实际使用过哪些目录。

## 决策

Windows 卸载在 `customUnInstall` 中运行编译的原生辅助程序（`installer/uninstall-data.cpp`，策略在 `installer/uninstall-cleanup.h`）；`$INSTDIR` 之外的所有删除都经由它，并按上游同样的做法从投影的 NSIS 模板中剥离原版 `--delete-app-data` 的 `RMDir /r` 旁路。

分层清理只删除经验证的可重建目标——`managed-toolchains/`、`electron/toolchains/bin`、具名 Chromium 缓存（`Cache/`、`Code Cache/`、`GPUCache/`、`DawnGraphiteCache/`、`DawnWebGPUCache/` 及各分区对应目录）与更新器缓存——每个目标都要先通过归属验证与预期清单检查。`desktop-preferences.json`、`network-secrets/`、`network-startup-override.json`、`electron-host.patch.yml` 与全部持久化浏览器存储保留。`--delete-app-data` 只在路径历史记录能证明完整性时才升级为整根 `userData` 删除；更新（`--updated`）与同产品替换（`/KEEP_APP_DATA`）保护优先于一切删除请求。

逐行的路径历史记录（`%APPDATA%\rivetdeck-path-history.ini`，位于默认 userData 旁，非提权进程总能写入）在跨进程写锁下合并每次打包启动解析出的 `userData` 与 `DSH_HOME`。记录的 `dshHome` 声明永远提供保护；记录的 `userData` 声明用于定位清理候选，本身不提供保护。真正的卸载追加 `retired=1`，丢弃该安装的候选与完整性，同时保留全部 home 与未知声明，因此重装无法清理仅由前次安装记录的根。

安全性是被证明而非被假设的。记录缺失、损坏、已退役或无法解析时历史即为不完整；不完整历史整体保留开放清单目标（具名缓存、运行时目录树、更新器缓存），并禁止 `--delete-app-data` 整根删除，因为任何清单都无法排除任意子树中未记录的 Harness home。删除候选必须通过标记文件验证产品归属并匹配预期清单——外来内容使整个目标被跳过而不是被一并清空。保护集合同时包含记录路径与其解析后的 junction 或 symlink 目标；无法解析的保护路径会阻断一切没有它就无法证明安全的删除。存在性无法查询的目标会连同错误一起记入残留报告，绝不按不存在处理。

## 外部先例

下表是评审时支持"默认保留"的证据：各 agent CLI 与编辑器的主流做法是删除二进制、保留用户状态，并把数据删除做成显式选择加入或文档化的手动步骤。来源为评审当时各官方文档与 issue tracker 的现行版本。

| 工具 | 移除机制 | 卸载时的用户数据 |
| --- | --- | --- |
| electron-builder NSIS | 原版卸载器 | 仅在 `--delete-app-data` 或 `DELETE_APP_DATA_ON_UNINSTALL` 时删除 |
| VS Code | Inno Setup 卸载器 | `%APPDATA%\Code` 与 `~/.vscode` 按设计保留（microsoft/vscode#66837，有意关闭）；文档发布"彻底卸载"路径清单 |
| Cursor | 卸载器 | `%APPDATA%\Cursor`、`~/.cursor`、`%LOCALAPPDATA%\cursor-updater` 保留；支持方确认沿用 VS Code 策略 |
| Chrome | 卸载器 | "同时删除浏览数据"复选框，默认不勾选 |
| Squirrel.Windows | Update.exe | `%LocalAppData%\<app>` 永不删除（残留还充当整机安装的"用户已卸载"标记）；`--squirrel-uninstall` 事件中应用侧 `rimraf` 对锁定文件会失败 |
| Claude Code | 按安装方式移除（原生 `rm`、`npm uninstall -g`、brew、winget） | `~/.claude` 与 `~/.claude.json` 始终保留——与桌面应用及 IDE 扩展共享；文档发布手动清理命令 |
| Codex CLI | 无卸载器 | `$CODEX_HOME`（`~/.codex`）从不触碰；社区方案只删二进制与独立包缓存 |
| Devin CLI | `devin uninstall` | 默认交互确认；`--clean` 删除全部数据（配置、历史、自定义数据），`--force` 跳过确认 |
| Pi | 重跑安装器 →"Uninstall Pi"，或 npm/Nix 移除 | 文档明示：`~/.pi/agent/` 下的配置、凭据、会话永不删除 |
| omp | 无（开放需求） | 社区提案：默认只删二进制，`--purge` 删 `~/.omp`，拒绝删有未提交工作的 worktree |
| opencode | `opencode uninstall`（v2 CLI 文档） | 默认删除二进制及所有相关文件；`--keep-config` 与 `--keep-data` 保留配置与会话数据；`--dry-run` 预览 |

两条观察决定了分层划分。第一，默认保留仍是设置、凭据与会话内容的主流策略；反例 opencode 默认删除，但通过 `--keep-config`/`--keep-data` 区分可保留类别，而不是把所有状态当作一个整体——这正是本设计需要的类别划分。第二，大型可重建产物是公认的可删除对象：opencode 删除其全局缓存，上游删除 `userData`；`managed-toolchains` 与更新器缓存属于这一类，而 `desktop-preferences.json` 与 `network-secrets/` 不属于。

## 上游移植基础

上游 `apps/desktop` 应用实现了下游所缺的清理模型；来源：`apps/desktop/installer/uninstall.nsh`、`apps/desktop/installer/uninstall-data.h`、`apps/desktop/scripts/installer.nsh`、`apps/desktop/scripts/windows-directory-installer.mjs`——其决策见 [Windows 卸载保留 Harness home](../../archived/feature/2026-09-08-desktop-uninstall-preserve-dsh-home.md)。

归属划分：上游在真正卸载时删除全部 Electron 自有数据且不触碰 Harness home——安装目录（含捆绑的 primary runtime）、Electron `userData`（同时保存日志与崩溃报告）与更新器缓存被删除；`DSH_HOME` 下的一切保留，包括应用专属的 `profiles/desktop` profile 与锁。

结构差异：上游的 Node、pnpm 与 Python 随安装包载荷进入 `$INSTDIR`，随程序一并删除。下游则在安装后把托管 Node/Python 下载到 `userData/managed-toolchains`，因此上游不存在运行时残留问题——下游必须删除 `userData` 子树才能回收这些运行时。

卸载流程：`customUnInstall` 调用 `un.CleanData`，在 `${isUpdated}` 下不动作，为不同安装目录的同产品替换保留 `/KEEP_APP_DATA`，读取 `DSH_HOME` 仅用于保护，删除 `$APPDATA\${PRODUCT_FILENAME}`、存在时的 `$APPDATA\${APP_PACKAGE_NAME}` 与 `$LOCALAPPDATA\${DSH_UPDATER_CACHE_NAME}`，然后把清空的父目录剪到固定停止目录。`windows-directory-installer.mjs` 剥离 electron-builder 的应用数据删除块，使删除只经由原生辅助程序。

删除安全：`$DSH_HOME/profiles/*/node_modules` 与工具链目录树包含 junction 和 symlink，朴素的递归删除可能逃逸到链接目标。移植的辅助程序规范化并拒绝畸形路径、文件系统根与受保护的 known folder；拒绝包含或被包含于 `$INSTDIR` 或所配置 Harness home 的目标；用打开的句柄钉住父目录并拒绝 reparse-point 根；不跟随链接地删除目录树；对每个同级项逐一尝试并汇报首个错误，容忍锁定文件残留，使仍在运行的 Host 不会令卸载失败。

迫使采用路径历史记录的限制：上游只从卸载进程自身环境读取 `DSH_HOME`，能保护默认与永久设置的情形，但无法恢复临时设置的 home 或历史 `--user-data-dir`。曾经指向 `userData` 内部的 `DSH_HOME` 可能把会话放进删除根，因此设计要求持久化发现而非仅信任环境。

## 备选方案

**默认整根 `userData` 删除（对齐上游）。** 作为默认被否决：它会丢弃代理配置、更新渠道、运行时引导状态与仍可用的加密凭据，并可能让代理用户重装后无法重新下载运行时。仅保留为显式 `--delete-app-data` 请求，且以完整历史为前提。

**Chrome 式选择加入页面。** 向导式卸载器提供"同时移除应用数据"选项（默认保留；静默模式用 `--delete-app-data`）被否决：它增加自定义卸载页与双语本地化，且仍会给多数用户留下工具链残留——分层默认已经无需让用户理解选择即可回收大头残留。

**仅命令行开关。** 沿用原版 `--delete-app-data` 语义并扩展到更新器缓存被否决：该开关事实上不可发现，残留照旧成为常态。

## 延期项

- 应用内"重置应用数据"（Settings）或 `dsh` 侧清理命令：重置设置与删除用户安装包是两个不同操作，独立于卸载立项。
- MSIX 一致性验证：操作系统移除包及其虚拟化文件数据，但 Microsoft 区分虚拟化文件与既有的非虚拟化文件（后者可能残留），且 `~/.dsh` 在虚拟化之外。宣称一致性前所需覆盖：首次 Store 安装、覆盖既有 NSIS 数据的 Store 安装、以及自定义路径在包外的 Store 安装。

## 后果

卸载回收了大块可重建残留，同时重装保留可用的代理配置、凭据与浏览器状态。仍在运行的 Host 或 agent 子进程持有的锁定文件产生已报告的残留，而不是失败或半静默的卸载。应用数据按用户隔离：以不同于使用账户的身份卸载只能触及该账户的根与记录。早于 `Rivetdeck` 产品名的版本写入 `%APPDATA%\DeepSeek Harness`，没有任何记录能指认它——只能手动移除。具名缓存清单之外的 Chromium 目录（`Crashpad`、`Service Worker` 及其他诊断或注册状态目录）在具备完整历史的 `--delete-app-data` 之前保留。

原生回归覆盖：被拒根、保护 home 重叠与 junction 解析、钉住后改名阻断、锁定与只读文件、空父目录修剪、历史解析与退役、清单验证、归属判定、分层清理、枚举与属性查询故障、以及报告写入独立性。Desktop CI 运行安装/卸载场景，覆盖更新、替换、遗留与不完整历史、以及 `--delete-app-data` 逃生门。
