# 卸载与数据清理

[English](uninstall-data-cleanup.md) | 中文

> 状态：**已在 Windows NSIS 实现——安装/卸载场景由 Desktop CI 验证**
>
> 本文档记录当前（CURRENT）卸载行为、上游 `apps/desktop` 的清理设计、外部 agent 工具先例，以及已落地的评审设计。外部评审认可了三项原则——保护 `$DSH_HOME`、更新时跳过清理、不跟随链接删除——并否决了无条件删除 `userData` 的做法。文末的评审结论即后续开发的工作约定，遗留开放问题在结尾列出。

## 当前卸载行为

下游 Windows 安装包是由 `apps/electron/scripts/prepare-windows-installer.mjs` 生成的辅助式 NSIS 安装器（`oneClick: false`、`allowToChangeInstallationDirectory: true`、ZIP 载荷）。在 Windows 打包机上，该脚本还会通过 `scripts/prepare-windows-uninstall-helper.ps1` 将 `installer/uninstall-data.cpp` 编译为 `rivetdeck-uninstall.dll`，投影默认模板时剥离 `--delete-app-data` 的 `RMDir /r` 数据删除旁路，并生成 `customInstall`/`customUnInstall` 宏以及由 `installer/uninstall-messages.yml` 生成的 LangString。

每次打包后启动时，应用在执行可能失败的网络与运行时初始化之前，先把解析后的 `userData` 与 `DSH_HOME` 合并进默认 `userData` 旁的逐行记录（`src/path-history.ts`，`%APPDATA%\rivetdeck-path-history.ini`），保证中途失败的启动也留下本次的根目录记录。记录位于安装目录之外，无需安装权限即可写入。跨进程写锁覆盖每次读取、合并与写入，使使用不同 `userData` 根的并发启动保留全部路径声明。如果无法读取或更新记录，启动会报告错误，并在初始化服务或打开 Harness home 之前停止。仅当没有先前注册的安装且默认 `userData` 不存在时才以 `complete=1` 播种；升级或在遗留用户数据上重装会生成不完整记录，因为此前的根目录未知。

卸载时 `customUnInstall` 调用 `un.RivetdeckCleanData`：当卸载器因更新（`--updated`）或同产品替换（`/KEEP_APP_DATA`）而运行时保留全部数据；记录位于默认 `userData` 旁、`$INSTDIR` 之外，本来就能留存给后续安装。否则该流程解析当前 `userData` 根（`$APPDATA\Rivetdeck`）、更新器缓存（`%LOCALAPPDATA%\rivetdeck-updater`）、环境 `DSH_HOME` 与记录文件，交给原生 `UninstallCleanup` 入口（由 `installer/uninstall-data.cpp` 导出，策略在 `installer/uninstall-cleanup.h`）。辅助程序执行分层策略：通过归属与预期清单校验后删除 `managed-toolchains/`、`electron/toolchains/bin`、具名缓存目录（含各分区对应目录）与更新器缓存；保留 `desktop-preferences.json`、`network-secrets/`、`network-startup-override.json` 与持久化浏览器存储。`--delete-app-data` 仅在记录存在且完整时删除整个 `userData` 根。具名缓存、托管运行时目录树与更新器缓存要求完整历史；否则整体保留，因为清单无法排除任意子树中未记录的 Harness home。保护范围同时包含记录的路径及其解析后的 junction 或符号链接目标；无法访问或已失效的链接会阻止清理。校验失败或与保护路径重叠的目标整体跳过；跳过项与删除失败写入 `%APPDATA%\Rivetdeck-uninstall-residue.log` 并显示在卸载器详情页。枚举错误会拒绝部分清单。清理错误与辅助程序调用失败也会显示本地化警告；报告写入失败时显示 Windows 错误码与跳过的目标数，不指向不可用的报告。

macOS 的 DMG/ZIP 与 Linux 的 AppImage 不带卸载器；DEB 只移除 `/opt/Rivetdeck`。MSIX（应用商店）构建由操作系统卸载并连带其虚拟化的包内数据，但预先存在的非虚拟化文件会保留，`~/.dsh` 也在虚拟化范围之外——验证缺口见"其他平台"一节。

## 写入位置与归属

每个写入根目录都需要明确归属与清理策略：

| 根目录 | 内容 | 归属与策略 |
| --- | --- | --- |
| `$INSTDIR` | 程序文件、`resources/core-runtime`（Windows `node.exe`）、`resources/network-runtime` | 安装器——已被删除 |
| `userData/managed-toolchains` 与 `userData/electron/toolchains` | 下载的 Node/Python 世代、收据、staging、shim | 应用私有、完全可重建——主要清理目标 |
| `userData` 内的 Chromium 缓存目录 | `Cache/`、`Code Cache/`、`GPUCache/`、`DawnGraphiteCache/`、`DawnWebGPUCache/` 及各分区下的对应目录 | 应用私有、可重建——清理目标 |
| `userData`（其余部分） | `desktop-preferences.json`（代理配置、更新频道、运行时引导）、`network-secrets/`（仍可使用的加密代理凭据）、`network-startup-override.json`、`electron-host.patch.yml`、持久化浏览器存储（cookies、Local Storage、IndexedDB 及其他会话分区数据） | 应用私有设置、凭据与用户内容——评审后设计中默认保留 |
| 更新器缓存 | 下载的更新包 | 应用私有、可重建——清理目标 |
| `$DSH_HOME/electron` | `python-user/` 与 `node-global/` 用户安装的包、`bin/` shim、`host-profile/`、标记文件 | 共享主目录内的应用私有子树——卸载器不得删除；内容是用户安装的包而非缓存 |
| `$DSH_HOME`（其余部分） | 会话、storages、设置、`.credentials.yaml`、web profile、插件、缓存 | 共享 Harness home——`dsh` CLI 与其他消费者共用；绝不自动删除 |
| `~/.agents` | 跨 agent 工具共享的用户级 skills | 共享——绝不自动删除 |
| 工作区目录 | 用户项目 | 用户——绝不删除 |

`userData` 可由 `--user-data-dir` 重定位，`$DSH_HOME` 可由 `DSH_HOME` 环境变量覆盖。卸载器仅凭自身环境无法发现这些覆盖，见"路径发现与保护"一节。

## 上游 `apps/desktop` 的设计

上游桌面应用已经实现了下游缺失的清理模型。来源：`apps/desktop/installer/uninstall.nsh`、`apps/desktop/installer/uninstall-data.h`、`apps/desktop/scripts/installer.nsh`、`apps/desktop/scripts/windows-directory-installer.mjs`。

### 归属划分

上游在真实卸载时删除全部 Electron 自有数据，并绝不触碰 Harness home。Electron 自有数据包括安装目录（含打包的主运行时）、Electron `userData`（通过 `app.setAppLogsPath()` 还包含日志与崩溃报告）以及更新器缓存。Harness 自有数据是 `DSH_HOME` 下的全部内容——包括应用专属的 `profiles/desktop` profile 与锁（`apps/desktop/src/paths.ts`），这些也保留。

### 结构差异：打包运行时与托管运行时

上游的 Node、pnpm 与 Python 随安装包载荷分发（`scripts/prepare-primary-runtime.ts` 构建带完整性清单的 `primary-runtime` 树，由 `src/runtime-tree.ts` 校验），位于 `$INSTDIR` 内，随程序一并删除。下游则在安装后把托管 Node/Python 下载到 `userData/managed-toolchains`（见 `runtime-environments.md`），因此上游不存在运行时的卸载残留问题：下游必须删除 `userData` 的子树才能回收这些运行时。

### 卸载器流程

`customUnInstall` 调用 `un.CleanData`，其行为为：

1. 在 `${isUpdated}` 下不执行任何操作——更新绝不能删除数据。
2. 尊重 `/KEEP_APP_DATA`，用于旧卸载器被另一安装目录卸载器替换的场景。
3. 从环境中读取 `DSH_HOME` 用于保护该目录，而非删除它。
4. 删除 `$APPDATA\${PRODUCT_FILENAME}`、存在时的 `$APPDATA\${APP_PACKAGE_NAME}`，以及 `$LOCALAPPDATA\${DSH_UPDATER_CACHE_NAME}`（其中还包含刻意留在 `$PLUGINSDIR` 之外的安装器日志）。
5. 向上清理空父目录，直到固定的停止目录为止。

`windows-directory-installer.mjs` 对默认模板做适配：它完整剥离了 electron-builder 的应用数据删除块，使数据删除只经由原生辅助程序进行，绝不对数据根目录执行 `RMDir /r`。

### 删除安全性（`uninstall-data.h`）

由于 `$DSH_HOME/profiles/*/node_modules` 与工具链目录树中存在 junction 与符号链接，朴素的递归删除可能逃逸到链接目标。该原生辅助程序因此：

- 规范化并拒绝非法路径、文件系统根目录与受保护的已知文件夹；
- 拒绝包含 `$INSTDIR` 或所配置 Harness home、或被其包含的目标；
- 用打开的句柄钉住父目录，并拒绝以重解析点为根的删除；
- 删除目录树时不跟随链接进入外部目标；
- 尝试每一个同级项并汇报首个错误，容忍因文件锁定造成的残留，使仍在运行的 Host 不会导致卸载失败。

### 上游路径发现模型的局限

上游只从卸载进程自身的环境读取 `DSH_HOME`。这能保护默认位置和永久设置的情形，但无法恢复为单次启动临时设置的 `DSH_HOME` 或历史上的 `--user-data-dir`。如果应用曾以指向 `userData` 内部的 `DSH_HOME` 运行，一个只相信当前环境的卸载器可能删除存有会话的目录。因此下述评审后设计要求持久化的路径记录，而非仅依赖环境发现。

## 外部先例

各 agent CLI 与编辑器的主流模式是：卸载时删除二进制/程序文件，默认保留用户状态，数据删除以显式 opt-in、keep 开关的反向形式或文档化手动步骤提供。来源为撰写本文时对应版本的官方文档与 issue 跟踪。

| 工具 | 卸载机制 | 卸载时的用户数据 |
| --- | --- | --- |
| electron-builder NSIS | 默认卸载器 | 仅 `--delete-app-data` 或 `DELETE_APP_DATA_ON_UNINSTALL` 时删除 |
| VS Code | Inno Setup 卸载器 | `%APPDATA%\Code` 与 `~/.vscode` 按设计保留（microsoft/vscode#66837，以"有意为之"关闭）；文档提供"干净卸载"手动路径清单 |
| Cursor | 卸载器 | `%APPDATA%\Cursor`、`~/.cursor`、`%LOCALAPPDATA%\cursor-updater` 保留；官方确认沿用 VS Code 策略 |
| Chrome | 卸载器 | "同时删除浏览数据"复选框，默认不勾选 |
| Squirrel.Windows | Update.exe | 从不删除 `%LocalAppData%\<app>`（残留目录还兼任机器级安装的"用户已卸载"标记）；应用在 `--squirrel-uninstall` 事件里 `rimraf` 会因文件锁定失败 |
| Claude Code | 按安装方式卸载（native `rm`、`npm uninstall -g`、brew、winget） | `~/.claude` 与 `~/.claude.json` 一律保留——与桌面应用及 IDE 扩展共享；文档提供手动清理命令 |
| Codex CLI | 无卸载器 | 从不触碰 `$CODEX_HOME`（`~/.codex`）；社区脚本只删除二进制与 standalone 包缓存 |
| Devin CLI | `devin uninstall` | 默认交互确认；`--clean` 删除全部数据（配置、历史、自定义数据），`--force` 跳过确认 |
| Pi | 重跑安装器选 "Uninstall Pi"，或 npm/Nix 卸载 | 文档明确：`~/.pi/agent/` 下的配置、凭据、会话从不删除 |
| omp | 无（开放的需求 issue） | 社区提案：默认只删二进制，`--purge` 才清 `~/.omp`，存在未提交 worktree 时拒绝删除 |
| opencode | `opencode uninstall`（v2 CLI 文档） | 默认删除二进制与全部相关文件；`--keep-config` 与 `--keep-data` 分别保留配置与会话数据；`--dry-run` 可预览 |

经评审后仍成立的两点观察。其一，设置、凭据与会话内容的默认保留仍是主流策略；反例 opencode 默认删除，但通过 `--keep-config`/`--keep-data` 区分了可保留的数据类别，而非把全部状态视为一个整体——这正是本设计需要的分类方式。其二，大体积可重建产物是公认的删除对象：opencode 删除其全局缓存，上游删除 `userData`；下游的 `managed-toolchains` 与更新器缓存属于同类，而 `desktop-preferences.json` 与 `network-secrets/` 不属于。

## 候选设计

Windows NSIS 卸载器的决策空间由四个设计覆盖；四者都共享同一前提——绝不触碰 `$DSH_HOME`、`~/.agents` 与用户工作区文件。

- **D——分层清理（评审建议）。** 卸载时只删除明确可重建的目标——`managed-toolchains/`、`electron/toolchains/bin`、具名纯缓存目录（`Cache/`、`Code Cache/`、`GPUCache/`、`DawnGraphiteCache/`、`DawnWebGPUCache/` 及各分区下的对应目录）、更新器缓存——同时保留 `desktop-preferences.json`、`network-secrets/`、`network-startup-override.json` 与全部持久化浏览器存储。会话分区不是缓存：其中可能有 cookies、Local Storage 与 IndexedDB，承载着未发送草稿等真实用户状态，因此只有 `--delete-app-data` 才删除它们——该参数升级为完整删除 `userData`。它既回收了大体积残留，又不会牺牲可用的代理配置——手动代理用户重装后可能要先靠它才能重新下载运行时。
- **A——默认完整删除 `userData`（对齐上游）。** 删除 `$DSH_HOME` 之外的全部 Electron 自有数据。它只能作为一项明确的产品决策保留，而非无代价收益：会丢弃代理配置、更新频道、运行时引导状态和仍可使用的加密凭据，还可能让代理用户重装后无法重新下载运行时。
- **B——Chrome 式 opt-in。** 辅助式卸载器提供"同时删除应用数据"选项（默认保留）；`/S` 保留数据；`--delete-app-data` 在静默模式下强制完整删除。保留了"重装即恢复设置"的体验，但需要定制卸载器页面及其本地化，且多数用户的工具链残留依旧。
- **C——仅开关。** 沿用 `--delete-app-data` 语义并把更新器缓存纳入，文档说明该开关。改动最小，但几乎无人知晓——今天的残留状况不会改变。

独立的应用内"重置应用数据"入口或文档化命令仍然可行，但按评审意见单独划定范围（见评审结论）。

## 路径发现与保护

"绝不删除 `$DSH_HOME`"只有在卸载器知道应用实际使用过哪些目录时才能兑现。卸载进程自身的环境是不够的：启动脚本可以临时设置 `DSH_HOME`，`--user-data-dir` 也会重定位托管运行时所在的根目录。因此设计必须在实现前定义：

1. **有效根目录的持久化历史集合。** 每次启动把解析后的 `userData` 与 `DSH_HOME` 路径合并进持久记录，而不是覆盖上一条：早期用过、后来切换走的 Harness home 仍然受保护。记录存放在卸载器无需应用启动环境即可读取的、按用户与安装实例区分的位置——例如产品 HKCU 卸载注册表项下的值，或 `$INSTDIR` 按用户可写时放在卸载器旁的文件。它不得依赖写入所有用户共享的 `$INSTDIR` 或 HKLM，普通权限运行的应用无法更新它们。记录还需标记自身覆盖度：升级后才首次生成的记录无法证明升级前使用过哪些根目录，因此携带"历史不完整"状态，维持下文的保守跳过，而不是伪装成完整历史。
2. **记录路径按用途分工。** 历史 `DSH_HOME` 一律进入保护集合。历史 `userData` 用于定位并验证清理候选，本身不构成保护——其中的设置与持久化存储通过与当前根目录相同的分层策略得到保留。
3. **删除候选验证归属。** 删除目标必须可归因于本产品且匹配预期清单——例如 `desktop-preferences.json` 或 `managed-toolchains/{node,python}/active.json`——不能只凭路径字符串信任。
4. **保护路径不要求归属标记。** 记录中的 `DSH_HOME` 无条件进入保护集合；共享 Harness home 可能完全不含 Electron 标记。记录异常或无法解析不构成丢弃保护声明的理由——它会阻止一切无法证明安全的删除。
5. **安全须证明而非假设。** "未发现重叠"不等于"不存在重叠"：历史记录缺失或不完整时，无法排除过去曾把 `DSH_HOME` 放在 `userData` 内部，因此没有证据不构成删除授权。每个删除目标都必须证明自身隔离——`--delete-app-data` 完整删除 `userData` 需要完整的历史记录证明其中从未存在受保护路径；需要清单校验的分层目标必须匹配预期内容，出现外来内容时整体跳过而不是连同一起清空。具名缓存、运行时 generation 与 staging、更新器 staging 没有封闭的内容清单，因此历史不完整时整体保留并报告对应清理目标。任一与受保护路径重叠——记录所得或环境所得——的删除目标同样整体跳过，并在报告的残留中体现。无记录的存量安装——或记录标记历史不完整的安装——以"环境加默认值"做保护并适用同样的证明要求，因此只能清理验证通过的目标。

## 安全要求

1. 更新过程中（`isUpdated`）与同产品卸载器替换过程中（`/KEEP_APP_DATA` 等价物）绝不删除数据；这些保护优先于一切删除请求，包括 `--delete-app-data`。
2. `$INSTDIR` 之外的所有删除都经由移植自上游 `uninstall-data.h` 的最小原生辅助实现及其安全测试完成。生成的模板中 stock `--delete-app-data` 的 `RMDir /r` 旁路必须像上游一样剥离——固定文件名不构成防御，因为路径链上的父目录本身可以是 junction。
3. 拒绝受保护根目录，以及任何包含 `$INSTDIR` 或解析所得 `DSH_HOME`、或被其包含的目标。
4. 定位目标时尊重持久化路径记录、`--user-data-dir` 与 `DSH_HOME`；目标无法解析并验证时拒绝清理。
5. 清理是尽力而为，而非"无残留"承诺：仍在运行的 Host 或 agent 子进程持有的锁定文件被跳过并可观察地报告，而不是让卸载半途失败。"容忍锁定文件"与"保证无残留"不能同时成立；约定是尽力删除并报告残留。
6. 任何卸载器参数下都不得删除含凭据或用户内容的根目录（`$DSH_HOME` 含 `electron/` 在内、`~/.agents`、工作区）。

## 其他平台

只有 Windows 有卸载器。为保持一致性，设计还应：

- 在面向用户的文档中发布准确的各平台"干净卸载"清单：macOS `~/Library/Application Support/Rivetdeck` 与 `~/Library/Caches/rivetdeck-updater`；Linux `${XDG_CONFIG_HOME:-~/.config}/Rivetdeck` 与 `${XDG_CACHE_HOME:-~/.cache}/rivetdeck-updater`；`~/.dsh` 可选但需注明其为共享目录；
- 把应用内"重置应用数据"（Settings）或 `dsh` 侧清理命令推迟到单独划定范围的改动；"重置设置"与"删除用户安装的包"是两个不同操作；
- 将 MSIX 等价性视为未验证而非免费：操作系统会移除包及其虚拟化文件数据，但微软明确区分虚拟化文件与预先存在的非虚拟化文件，后者可能保留。当前 Store 冒烟只确认包已注销，运行时冒烟又使用包外的自定义 `userData`，因此默认工具链位置在 Store 卸载下的去向未经验证。需要的覆盖：首次 Store 安装、在既有 NSIS 数据之上安装 Store 版、以及包外自定义路径三种情况。

## 评审结论

| 议题 | 结论 |
| --- | --- |
| 设计选择 | 新增并推荐候选 D：默认清理工具链与缓存，保留偏好与凭据，完整删除由显式选项触发。方案 A 仅作为明确的产品决策保留。 |
| `$DSH_HOME/electron` | 卸载器绝不删除；`python-user/` 与 `node-global/` 存放用户安装的包，不是缓存。 |
| 原生删除辅助程序 | 将上游最小实现及其安全测试移植进 `apps/electron`；所有删除入口统一经由它；剥离 stock `--delete-app-data` 的递归删除旁路。 |
| 卸载器本地化 | 由下游 `apps/electron` 的安装器资源负责，构建期生成 NSIS 本地化文本。 |
| 应用内重置 | 单独划定范围；"重置设置"与"删除用户安装的包"是两个独立操作；可后续独立实施。 |
| 其他平台 | 本阶段只提供准确的手动清理文档；Store 等价性需要上述验证矩阵。 |
| `--delete-app-data` | 为兼容性保留；在候选 D 下表示显式完整清理 `userData`；更新与 `/KEEP_APP_DATA` 保护优先于删除请求。 |

## 实现验收标准

- 普通交互式与静默卸载删除经过验证的可重建目标，保留设置、凭据与持久化浏览器存储；具名缓存、托管运行时目录树与更新器缓存还要求完整历史。
- 更新与换装到不同目录保留全部数据。
- 早期启动用过、后来切换走的 `DSH_HOME` 在卸载时仍受保护，因为历史集合保留了它。
- `--user-data-dir` 切换后遗留的历史目录适用同一分层策略：设置与持久化存储默认保留，可重建子目录仍被清理。
- 任何删除根目录中的 junction 与符号链接只解除自身而不进入目标；链接后方内容保持完好。
- 与任一受保护路径重叠的删除目标被整体跳过，且跳过在报告的残留中可观察。
- 临时设置的 `DSH_HOME` 或 `--user-data-dir`（已记录、但卸载环境中不存在）仍被正确兑现。
- 无历史记录的存量安装——或记录标记历史不完整——若曾在 `userData` 内嵌套使用 `DSH_HOME`，则无法证明隔离：`--delete-app-data` 跳过 `userData` 根目录并报告残留，而不是删除历史会话。
- 锁定文件产生被报告的残留，而不是失败或静默残缺的卸载。
- 声明 MSIX 等价性之前跑通 Store 验证矩阵（首次安装、既有 NSIS 数据、包外自定义路径）。

## 已知限制

- 即使在全用户安装下，应用数据仍按用户存放。由另一个账户执行卸载只能清理该账户自己的 `userData`、更新器缓存与记录文件；其他用户的根目录需由各自用户卸载或手动删除。
- 早于 `Rivetdeck` 产品名的构建写入 `%APPDATA%\DeepSeek Harness`，没有任何记录能引用该根目录，卸载器无法触及——如存在需手动删除。
- 具名缓存列表之外的 Chromium 目录——`Crashpad`、`Service Worker` 及其他诊断或注册状态目录——分层清理后仍会保留，只有 `--delete-app-data` 才会随根目录一并删除。
