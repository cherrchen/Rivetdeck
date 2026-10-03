# Desktop 网络设置

[English](network-settings.md) | 中文

## Summary

在 Settings → Network & Runtimes 中为 Desktop 应用和受监护的 Harness 选择 Default、Direct、System Proxy 或单一 Manual 代理。保存并重启后，模式或 Manual 配置生效。连接测试和高级诊断帮助查看当前路由，不改变该路由。

## Contents

- [选择模式](#choose-a-mode)
- [配置 Manual 代理](#configure-a-manual-proxy)
- [测试与诊断](#test-and-diagnose)
- [从路由故障恢复](#recover-from-a-failed-route)
- [排障](#troubleshoot)
- [兼容性](#compatibility)
- [限制](#limits)

<a id="choose-a-mode"></a>

## 选择模式

打开 Settings → Network & Runtimes，从网络模式菜单中选择一种模式。**Default** 保留应用现有网络行为。**Direct** 明确直连，并清理 Desktop 可控 Agent 子进程的代理环境变量。**System Proxy** 针对每个目标遵循操作系统策略，只执行第一条最终路由，其中包括明确的 `DIRECT`。**Manual Proxy** 对 Desktop 管理的流量使用一个 HTTP、HTTPS 或 SOCKS5 端点。

System 和 Manual 显示 **代理 Agent 网络请求**。启用后，支持标准代理环境变量的 Agent 工具会收到 Desktop Gateway。关闭后，Agent 子进程保留继承的代理变量和 `$DSH_HOME/.env` 中的代理变量。它不能强制 raw socket 或忽略这些变量的工具使用代理。Direct 始终清理可控 Agent 的代理变量；Default 保留 Agent 原有行为。

选择 **保存并重启** 来应用有效的模式或 Manual 配置。连接测试失败不会禁用保存。**恢复 Default** 会请求确认、保留上次 Manual 端点并重启。System 生效时，高级区域提供 **重新加载系统代理配置**；此操作更新 OS 策略和网络 epoch，不改变模式，也不重启。

<a id="configure-a-manual-proxy"></a>

## 配置 Manual 代理

只选择一种协议，输入主机名或 IP 地址以及 1 至 65535 的整数端口。Host 中不要包含 `http://`、路径或凭据。HTTP 和 HTTPS 可填写用户名和密码。HTTPS 加密到代理的连接，代理证书必须受操作系统信任。SOCKS5 不显示凭据字段，因为此版本只支持无需认证的 SOCKS5。

密码字段永远不会显示已保存的密码。固定的圆点占位符表示已保存密码；保持不变即可继续使用该 secret。输入新值可替换密码，或选择 **移除已保存的密码** 并保存来删除。若系统没有持久安全存储，保存新密码时可以取消，或保存其他设置并丢弃该密码。Linux `basic_text` 不视为安全存储；请启用 Secret Service 或 KWallet 来保留密码。

<a id="test-and-diagnose"></a>

## 测试与诊断

**测试连接** 会针对当前生效模式运行代理、Internet、GitHub 和 LLM API 的 GET 探测。它使用不产生 incident 的 updater 网络路径，因此测试失败不会打开全局代理故障对话框，也不会改变网络 epoch。来自目标站点的任何 HTTP 响应（包括 401）都表示传输可达；Gateway 故障仍显示为不可达及符号化错误代码。界面仍会显示状态码。Internet 测试只使用一个已配置的 204 URL，不尝试其他地址。GitHub 测试只检查可达性，不检查 updater release。

打开高级区域可编辑 Internet 和 GitHub 测试 URL，并为当前已注册的 provider 填写 LLM health URL。LLM 测试只向该 URL 发送 GET，不调用 completion endpoint，也不消耗模型 token。没有 provider 和 health URL 时，LLM 行显示 **未配置**。表单不会为自定义 provider 推断安全的 health URL。

高级区域还会显示当前模式、Gateway 状态、epoch、所选路由、上次故障，以及可用的 System 策略详情。System 的其他路由只用于诊断，绝不会自动尝试。页面仅显示脱敏元数据，不返回已存密码、认证 header 或 PAC 脚本。

<a id="recover-from-a-failed-route"></a>

## 从路由故障恢复

真实业务流量在所选代理上失败时，原生对话框可允许再次尝试、单次使用 Default、打开 Settings → Network & Runtimes 或暂不处理。**重试** 允许再次连接同一所选路由；请自行重试受影响的操作。**本次使用 Default** 通过一次性 override 重启，保留已保存模式。**打开网络设置** 会显示主窗口并选中 Network section，展示尚未解决的故障，但不改变模式。

页面也会显示上次未解决的代理故障，并提供同一路由的重试。测试不会创建该故障。System 策略变化和显式 Reload 会创建新 epoch；代理失败不授权尝试其他路由或 Direct。

取消 Basic 代理凭据提示后，故障仍然可见。同一 epoch 中后续需要凭据的请求可以再次提示。

<a id="troubleshoot"></a>

## 排障

所选代理失败后不会切换到其他代理或 Direct。使用故障对话框重试同一路由、单次使用 Default，或打开 Settings → Network & Runtimes。**Use Default This Time** 只重启一次，并保留已保存的模式。

如果保存时提示安全存储不可用，新密码不会写入。在 Linux 上启用 Secret Service 或 KWallet 后再次保存密码。`basic_text` 不是持久存储。

不受支持的 Linux 桌面在 System 模式下会阻断该路由。改用 Manual 或 Direct。GNOME 和 KDE 5/6 是受支持的 Linux 策略来源。

只修改操作系统代理设置的本地代理软件，会在 System Proxy 模式下被跟随。Default 以及命令行 `dsh` 进程仍使用 `HTTP_PROXY` 和 `HTTPS_PROXY`。

<a id="compatibility"></a>

## 兼容性

| 客户端或策略 | Desktop 模式 | Desktop 实际执行 |
| --- | --- | --- |
| Mihomo、Clash Verge Rev 或 Sparkle 混合端口 | Manual HTTP，指向该单一端口 | 一个 HTTP 上游同时处理普通请求和 CONNECT |
| 普通 SOCKS5 代理 | Manual SOCKS5 | 无认证 SOCKS5；由代理解析目标域名 |
| 操作系统代理、PAC 或 WPAD | System Proxy | 只执行第一条最终路由，包括明确的 `DIRECT` |
| 不使用代理 | Direct | 显式直连，并清理 Agent 代理变量 |

Windows 读取当前用户的 WinHTTP 设置。macOS 读取 CFNetwork。Linux 读取 GNOME GSettings 或 KDE 5/6 的 `kioslaverc`。不支持集成 NTLM 和 Negotiate 认证、SOCKS5 密码以及 Manual bypass。Desktop CI 在 Windows、macOS 和 Linux 上运行 Runtime。Windows 安装包冒烟检查要求存在 `resources/network-runtime/dsh-electron-network-runtime.exe`。签名 macOS 的 Keychain 行为和企业 WPAD 实验环境仍由操作者检查。

<a id="limits"></a>

## 限制

不支持 Manual bypass、SOCKS5 认证、自定义 HTTPS 代理 CA、客户端证书和集成代理认证。不受支持的 System 后端会阻断该路由。平台策略、认证和传输细节见 [Network Runtime](network-runtime.zh.md)。

## Dev Note

无。
