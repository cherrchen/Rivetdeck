# Desktop 运行环境

[English](runtime-environments.md) | 中文

Desktop 无需托管 Node.js 或 Python 即可启动。Core 执行由 Electron 拥有：macOS/Linux 使用 Electron 的 Node 兼容子模式，Windows 仅在 `resources/core-runtime` 中携带控制台子系统 `node.exe` 与许可证。隐藏控制台的 stdin 继承机制保留在 `spawnHarnessChild` 中。全新 Core profile 通过不含依赖的离线包操作初始化。客户端窗口加载后才执行 ecosystem 源协调；失败时随包插件仍可使用，退出前会取消并等待协调操作结束。Host 与随包 pnpm 使用 Core 执行器；移除可选运行环境不会删除它。

## 初始化与迁移

客户端 shell 对每个 Desktop 用户数据 profile 显示一次可选初始化对话框。Node 和 Python 默认未选中。安装所选环境会保存完成状态、在后台开始下载，并推进当前步骤。跳过会保存完成状态，不下载任何内容。遮罩和 Escape 不保存完成状态。对话框不渲染关闭控件。跳过、失败或移除后，设置 → 网络与运行环境始终可用。旧用户在功能引入时收到一次对话框。应用更新或之后移除运行环境不会重置完成状态。旧版随包环境和系统解释器不会被复制或显示为托管安装。

## 生命周期与存储

Main 拥有独立运行环境操作，并向初始化与设置共享状态。下载使用仓库 lockfile 的固定 HTTPS URL 与 SHA256、安全归档验证和解压、解释器版本检查、npm/npx 检查，以及 Python ssl/sqlite3/ctypes 与 pip 检查。一个运行环境失败会保留另一个。安装失败显示本地化错误类别，技术细节保留在 Main 日志中。取消会等待清理。中断的 staging 和未提交的安装目标目录在 Host 启动前清理。已验证的前代 generation 保持 installed 或 update-available，并带有被丢弃一代的 interrupted 告警。没有提交时保持 failed 与 interrupted。校验失败保持 corrupt。待完成安装记录其版本、平台和 generation，因此即使进程在 selector 提交后崩溃，清理也会保留已激活的运行时。

验证通过的 generation 位于 `userData/managed-toolchains/<runtime>/<version>/<platform-arch>/<generation>`。下载和解压在独立 staging 中完成。Main 仅在验证与不可变重命名成功后原子写入 active selector。Windows 重命名在限定时间内重试临时文件锁；取消会停止重试。更新安装新的 generation，并在 pinned 版本不同时显示可用更新。Node 的前代安装在重启时删除。Python 的前代安装在重启后仍保留，因为已安装的 console script 和项目虚拟环境引用其解释器绝对路径。这些命令继续使用原 Python 版本；保留前代安装会占用额外磁盘空间。应用更新保留用户数据安装，不自动下载。

安装与更新需要重启后才能改变 Agent fallback 路径。运行环境移除会延迟到重启时完成，保护使用 Agent fallback 路径或显式解释器路径的子进程。显式移除会删除选定托管 generation 及所有保留的前代安装；保留用户包目录、项目文件、系统解释器和 Core。引用已删除解释器的 console script 和虚拟环境需要重新安装或创建后才能使用。退出先等待安装操作停止，再关闭 Network Runtime。

用户包保留既有 Harness 位置：Python 使用 `$DSH_HOME/electron/python-user`，npm 全局安装使用 `$DSH_HOME/electron/node-global`。未设置 `DSH_HOME` 时，Harness home 为 `~/.dsh`（Windows：`%USERPROFILE%\.dsh`）。托管 shim 独立存放在 `userData/electron/toolchains/bin`。启动时不搬迁或合并用户包目录。Python 用户包仍按版本分目录存放；使用新的 Python 次版本时可能需要重新安装包。

## 网络与可执行文件选择

Main 通过已注册到 Desktop proxy applier 的 Electron Session 下载。Default 保留 Chromium 路由，Direct 显式直连，System/Manual 使用 Network Runtime Gateway，不直接回退。重定向必须保持 HTTPS。网络 epoch 更改取消正在进行的安装；设置更改重启应用。离线安装报告失败，不阻塞 Host 或关闭初始化对话框。

Agent 子进程保留请求、项目、用户及原始 PATH 的优先级。只有验证通过的托管环境才追加命令目录与托管 shim 作为 fallback。缺失的托管环境保持缺失；可执行文件查找使用其它可用来源，或报告 executable-not-found。Core 包管理命令使用被该策略排除的 Host 专用路径。
