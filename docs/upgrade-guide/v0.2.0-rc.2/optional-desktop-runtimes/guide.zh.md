---
kind: upgrade-guide
description: "当项目和系统都没有解释器时，Desktop Agent 任务需要显式安装托管运行环境。"
---
# Desktop 的 Node.js 和 Python 改为可选安装

[English](guide.md) | 中文

## 变更

Desktop 安装包不包含完整的 Node.js/npm/npx 和 Python/pip distribution。依赖这些内置解释器执行 Agent 任务的用户需要选择是否安装托管运行环境。Desktop Host、聊天和插件管理保留 Core 执行器，没有任何可选运行环境也能启动。旧版应用资源和系统解释器不会迁移到托管存储中。Python 用户包和 npm 全局工具保留在 `$DSH_HOME/electron/{python-user,node-global}`；升级不搬迁或删除这些目录。

## 迁移

1. 升级后首次启动时，在「可选运行环境」中选择 Node.js、Python、两者，或「暂时跳过」。跳过会保存选择，Desktop 仍可使用。
2. 任务需要托管解释器时，打开「设置 → 网络与运行环境」。分别下载所需环境并重启 Desktop，使 Agent 的后备路径生效。项目、用户和系统 PATH 条目保留优先级。
3. 确认所选运行环境显示「已安装」，并检查版本和用户数据目录中的位置。下载失败后可以重试，不会丢弃另一个已成功安装的环境。删除正在使用的环境会在重启后完成，并保留 Core 和项目文件。
4. 执行一个既有 npm 全局命令，并使用所选解释器导入一个 Python 用户包。绑定旧版随包解释器的 Python console script 需要重新生成入口：通过托管 shim 执行 `python -m pip install --user --force-reinstall <package>`，或从本地 wheel 重新安装。重新创建引用旧版随包解释器的项目虚拟环境。使用新的 Python 次版本时也可能需要重新安装包。
5. 之后重新安装或更新托管 Python 时，前代解释器会保留，供既有命令和虚拟环境使用。显式移除 Python 会在重启后删除这些解释器；再次使用依赖它们的环境前，需要重新创建环境或安装其包。

生命周期和网络行为详见[运行环境](../../../electron/runtime-environments.zh.md)。
