# 卸载与数据清理

[English](uninstall-data-cleanup.md) | 中文

> 状态：**现行参考——Windows NSIS 行为由 Desktop CI 验证**
>
> 分层策略的取舍理由、外部先例、上游移植基础与被否决的备选方案记录在 Agent Note [Electron 卸载采用分层数据清理](../../.agents/notes/implemented/feature/2026-10-18-electron-uninstall-tiered-cleanup.zh.md) 中。

## 当前卸载行为

下游 Windows 安装包是由 `apps/electron/scripts/prepare-windows-installer.mjs` 生成的向导式 NSIS 构建（`oneClick: false`、`allowToChangeInstallationDirectory: true`、ZIP 载荷）。在 Windows 打包机上，该脚本把 `installer/uninstall-data.cpp` 编译为 `rivetdeck-uninstall.dll`（`scripts/prepare-windows-uninstall-helper.ps1`），投影原版模板时剥离 `--delete-app-data` 的 `RMDir /r` 旁路，并生成 `customInstall`/`customUnInstall` 宏以及由 `installer/uninstall-messages.yml` 生成的 LangString。

每次打包启动都会在可能失败的启动步骤（网络或运行时准备）之前，把解析出的 `userData` 与 `DSH_HOME` 合并进默认 userData 旁的逐行记录（`src/path-history.ts`，`%APPDATA%\rivetdeck-path-history.ini`），因此在网络或运行时准备阶段失败的启动仍会留下根记录。该记录位于安装目录之外，无需安装权限即可写入。跨进程写锁覆盖每个读-改-写周期，因此不同 `userData` 根的并发启动都能保留当前安装内的每条声明。真正的卸载追加 `retired=1`：读取方丢弃该安装的 `userData` 清理候选与完整性，同时保留全部 `DSH_HOME` 与未知保护声明。下一次启动只以不完整历史记录其当前 `userData` 根。没有先前卸载注册的安装器也会在写入注册前退役任何存留记录；退役失败会中止安装，卸载会报告退役失败。更新与替换原样保留活动记录。若记录无法读取或更新，启动会报告错误并在初始化服务或打开 Harness home 之前停止。只有既无先前注册的安装、也无存留的默认 `userData` 根与更新器缓存的安装才播种 `complete=1`；该播种仅证明安装器检查过的默认 `userData` 根。发现未记录的非默认根会使历史不完整——即使该根带有产品标记，因为它更早使用过的 Harness home 无从知晓。回到已记录或默认根不会恢复完整性。在存留的用户数据或更新器缓存上升级、重装也会播种不完整记录。

卸载时，`customUnInstall` 调用 `un.RivetdeckCleanData`：当卸载器因更新（`--updated`）或同产品替换（`/KEEP_APP_DATA`）运行时保留全部数据；位于默认 `userData` 旁的记录在 `$INSTDIR` 之外，本来就能留存给后续安装。其余情况下，流程解析当前 `userData` 根（`$APPDATA\Rivetdeck`）、更新器缓存（`%LOCALAPPDATA%\rivetdeck-updater`）、环境变量 `DSH_HOME` 与记录，交给原生 `UninstallCleanup` 入口点（由 `installer/uninstall-data.cpp` 导出；策略在 `installer/uninstall-cleanup.h`）。辅助程序执行分层策略：`managed-toolchains/`、`electron/toolchains/bin`、具名缓存目录（含各分区对应目录）与更新器缓存在通过归属和预期清单检查后删除；`desktop-preferences.json`、`network-secrets/`、`network-startup-override.json` 与持久化浏览器存储保留。`--delete-app-data` 只在记录存在且完整时删除整个 `userData` 根。具名缓存、托管运行时目录树与更新器缓存要求完整历史，否则整体保留——因为它们的清单无法排除任意子树中未记录的 Harness home。保护同时涵盖记录路径及其解析后的 junction 或 symlink 目标；不可访问或损坏的链接会阻止清理。验证失败或与保护路径重叠的目标被整体跳过；跳过与删除失败写入 `%APPDATA%\Rivetdeck-uninstall-residue.log` 与卸载器详情页。枚举错误拒绝部分清单；存在性无法查询的路径连同其错误一并报告，而不是按不存在处理。清理错误与辅助程序调用失败还会显示本地化警告；报告写入失败会显示 Windows 错误与跳过目标数，而不指向不可用的报告。

macOS DMG/ZIP 与 Linux AppImage 产物不提供卸载器；DEB 仅删除 `/opt/Rivetdeck`。MSIX（Store）构建由操作系统移除，包括虚拟化的按包数据，但既有的非虚拟化文件会存留，且 `~/.dsh` 在虚拟化之外——验证缺口见"已知限制"。

## 写入位置与归属

每个写入根都需要明确的归属方与清理策略：

| 根 | 内容 | 归属与策略 |
| --- | --- | --- |
| `$INSTDIR` | 程序文件、`resources/core-runtime`（Windows `node.exe`）、`resources/network-runtime` | 安装器——已被删除 |
| `userData/managed-toolchains` 与 `userData/electron/toolchains` | 下载的 Node/Python 代际、回执、暂存、shim | 应用私有、完全可重建——主要清理目标 |
| `userData` 内 Chromium 缓存目录 | `Cache/`、`Code Cache/`、`GPUCache/`、`DawnGraphiteCache/`、`DawnWebGPUCache/` 及各分区对应目录 | 应用私有、可重建——清理目标 |
| `userData`（其余部分） | `desktop-preferences.json`（代理配置、更新渠道、运行时引导）、`network-secrets/`（可用的加密代理凭据）、`network-startup-override.json`、`electron-host.patch.yml`、持久化浏览器存储（cookies、Local Storage、IndexedDB 及其他会话分区数据） | 应用私有设置、凭据与用户内容——默认保留 |
| 更新器缓存 | 已下载的更新包 | 应用私有、可重建——清理目标 |
| `$DSH_HOME/electron` | `python-user/` 与 `node-global/` 用户安装包、`bin/` shim、`host-profile/`、标记 | 共享 home 内的应用私有子树——卸载器不得删除；内容是用户安装的包，不是缓存 |
| `$DSH_HOME`（其余部分） | 会话、存储、设置、`.credentials.yaml`、web profile、插件、缓存 | 共享 Harness home——`dsh` CLI 与其他消费方共用；绝不自动删除 |
| `~/.agents` | 各 agent 工具共享的用户级技能 | 共享——绝不自动删除 |
| 工作区目录 | 用户项目 | 用户——绝不删除 |

`userData` 可经 `--user-data-dir` 重定位，`$DSH_HOME` 可经 `DSH_HOME` 环境变量重定位。卸载器仅凭自身环境无法发现这些覆盖；见"路径历史与保护"。

## 路径历史与保护

"绝不删除 `$DSH_HOME`"之所以可执行，是因为卸载器知道应用实际使用过哪些目录；卸载进程自身环境无法回答这个问题——启动脚本可以临时设置 `DSH_HOME`，`--user-data-dir` 又可以重定位保存托管运行时的根。机制如下：

1. **有效根的持久化历史集合。** 每次启动把解析出的 `userData` 与 `DSH_HOME` 路径合并进一份持久记录，而不是覆盖上一条：较早启动使用、后来切走的 Harness home 保持受保护。记录存放在默认 userData 旁——一个卸载器无需应用启动环境即可读取、普通权限应用总能更新的按用户位置。它还跟踪自身覆盖度：升级后才创建的记录无法证明其存在之前运行过哪些根，因此带有不完整历史状态，保持保守跳过而不是假装历史完整。
2. **记录路径的角色分离。** 历史 `DSH_HOME` 项永远加入保护集合。历史 `userData` 项用于定位并验证清理候选；它们本身绝不构成保护——其中的设置与持久化存储通过与当前根相同分层策略得到保留。
3. **删除候选验证归属。** 删除目标必须可归因于本产品并匹配预期清单——例如 `desktop-preferences.json` 或 `managed-toolchains/{node,python}/active.json`——绝不只凭路径字符串取信。
4. **保护路径无需归属。** 记录的 `DSH_HOME` 无条件加入保护集合；共享 Harness home 可能完全不含 Electron 标记。畸形或无法解析的记录不会丢失保护声明——它会阻断一切没有该记录就无法证明安全的删除。
5. **安全是被证明的，不是被假设的。** "未发现重叠"不等于"不存在重叠"：历史记录缺失或不完整意味着无法排除 `userData` 内曾有过 `DSH_HOME`，因此没有证据不代表可以删除。每个删除目标必须证明自身隔离——`--delete-app-data` 下的整根 `userData` 删除要求完整历史记录，以证明保护路径从未位于其中；按清单校验的分层目标必须匹配预期内容，外来内容使整个目标被跳过而不是被一并清空。具名缓存、运行时代际与暂存、更新器暂存没有封闭清单，因此历史不完整时整个清理目标原样保留并报告。任何与保护路径重叠的目标——无论保护来自记录还是环境——同样整体跳过，并在残留中报告。早于记录出现的安装——或记录报告历史不完整的——使用环境加默认值做保护，并套用同样的证明要求，因此只处理能干净验证的目标。

## 删除规则

1. 更新（`isUpdated`）或同产品卸载器替换（`/KEEP_APP_DATA`）期间不删除任何数据；这些保护优先于一切删除请求，包括 `--delete-app-data`。
2. `$INSTDIR` 之外的所有删除经由自上游 `uninstall-data.h` 移植的原生辅助程序及其安全测试。原版 `--delete-app-data` 的 `RMDir /r` 旁路从生成的模板中剥离——固定文件名不是防线，因为链上的父目录本身可以是 junction。
3. 拒绝保护根以及任何包含或被包含于 `$INSTDIR` 或已解析 `DSH_HOME` 的目标。
4. 目标经持久化路径记录、`--user-data-dir` 与 `DSH_HOME` 定位；无法解析或验证的目标被拒绝，无法查询的目标连同错误报告而非按不存在处理。
5. 清理是尽力而为，不是无残留保证：仍在运行的 Host 或 agent 子进程持有的锁定文件被跳过并可观察地报告，而不是在删除中途令卸载失败。"容忍锁定文件"与"不留残留"无法同时承诺；约定是尽力删除并报告残留。
6. 承载凭据与用户内容的根（含 `electron/` 的 `$DSH_HOME`、`~/.agents`、工作区）在任何卸载开关下都不删除。

## 其他平台

只有 Windows 有卸载器。macOS DMG/ZIP 与 Linux AppImage 产物不删除数据；DEB 仅删除 `/opt/Rivetdeck`。各平台手动清理清单见[用户清理指南](user/cleanup-user-files.zh.md)。MSIX（Store）构建由操作系统移除，包括虚拟化的按包数据，但既有的非虚拟化文件会存留，`~/.dsh` 在虚拟化之外——一致性未经验证（见"已知限制"）。

## 已知限制

- 即使在全用户安装下，应用数据也是按用户隔离的。以不同于使用账户的身份卸载只能触及该账户的 `userData`、更新器缓存与历史记录；其他用户的根在各用户自行卸载或删除前保留。
- 早于 `Rivetdeck` 产品名的版本写入 `%APPDATA%\DeepSeek Harness`，这个根没有任何历史记录能指认，卸载器永远够不到。移除它是手动步骤。
- 具名缓存清单之外的 Chromium 目录——`Crashpad`、`Service Worker` 及其他诊断或注册状态目录——在分层清理后存留；只有 `--delete-app-data` 才会带离该根。
- MSIX 卸载一致性未经验证：操作系统移除包及其虚拟化文件数据，但 Microsoft 区分虚拟化文件与既有的非虚拟化文件，后者可能存留。当前 Store smoke 只确认包注销，运行时 smoke 又使用包外的自定义 `userData`，因此默认工具链位置在 Store 卸载下的去向未知；在宣称一致性之前必须运行首次 Store 安装、覆盖既有 NSIS 数据的 Store 安装、以及自定义外部路径的 Store 安装。
