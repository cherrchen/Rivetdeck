# Desktop Network Settings

English | [中文](network-settings.zh.md)

## Summary

Use Settings → Network & Runtimes to choose Default, Direct, System Proxy, or one Manual proxy for the Desktop application and supervised Harness. Save & Restart applies a mode or Manual change. Connection tests and Advanced diagnostics help inspect the active route without changing it.

## Contents

- [Choose a mode](#choose-a-mode)
- [Configure a Manual proxy](#configure-a-manual-proxy)
- [Test and diagnose](#test-and-diagnose)
- [Recover from a failed route](#recover-from-a-failed-route)
- [Troubleshoot](#troubleshoot)
- [Compatibility](#compatibility)
- [Limits](#limits)

<a id="choose-a-mode"></a>

## Choose a mode

Open Settings → Network & Runtimes and select one mode from the network mode menu. **Default** keeps the existing application network behavior. **Direct** explicitly connects without a proxy and clears proxy environment variables for Desktop-controlled Agent children. **System Proxy** follows operating-system policy for each destination and executes only its first final route, including an explicit `DIRECT`. **Manual Proxy** uses one HTTP, HTTPS, or SOCKS5 endpoint for Desktop-managed traffic.

System and Manual show **Proxy agent network requests**. When enabled, supported Agent tools receive the Desktop Gateway through standard proxy environment variables. When disabled, Agent subprocesses retain inherited proxy variables and those from `$DSH_HOME/.env`. It does not force proxy use by raw sockets or tools that ignore those variables. Direct always clears controlled Agent proxy variables; Default leaves existing Agent behavior untouched.

Select **Save & Restart** to apply a valid mode or Manual configuration. A failed connection test does not disable Save. **Restore Default** asks for confirmation, retains the last Manual endpoint, and restarts. **Reload system proxy configuration** is available in Advanced while System is active; it refreshes OS policy and the network epoch without changing mode or restarting.

<a id="configure-a-manual-proxy"></a>

## Configure a Manual proxy

Choose exactly one protocol and enter a host name or IP address plus an integer port from 1 to 65535. Do not include `http://`, a path, or credentials in Host. HTTP and HTTPS allow an optional username and password. HTTPS encrypts the connection to the proxy and requires its certificate to be trusted by the operating system. SOCKS5 shows no credential fields because this version supports only no-auth SOCKS5.

The password field never shows a stored password. A fixed bullet placeholder means that a password is stored; leaving it unchanged keeps that secret. Type a new value to replace it, or select **Remove saved password** and save to delete it. On a system without persistent secure storage, saving a new password opens a choice to cancel or save the other settings while discarding that password. Linux `basic_text` is treated as unavailable secure storage; enable Secret Service or KWallet to retain a password.

<a id="test-and-diagnose"></a>

## Test and diagnose

**Test connection** runs Proxy, Internet, GitHub, and LLM API GET probes against the currently active mode. It uses the incident-free updater network path, so a test failure does not open a global proxy failure dialog or change the network epoch. Any origin HTTP response, including 401, confirms transport reachability; Gateway failures remain unreachable with a symbolic error code. The response status remains visible. The Internet test uses one configured 204 URL without trying alternatives. GitHub tests reachability, not updater release availability.

Open Advanced to edit the Internet and GitHub test URLs and enter an LLM health URL for a currently registered provider. LLM testing sends GET to that URL and never calls a completion endpoint or spends model tokens. Without a provider and health URL, the LLM row reads **Not configured**. The form does not infer a safe health URL for a custom provider.

Advanced also shows active mode, Gateway status, epoch, selected route, last failure, and System policy details where available. Additional System routes are diagnostic only and are never tried automatically. The page shows sanitized metadata; it does not return a stored password, authentication header, or PAC script.

<a id="recover-from-a-failed-route"></a>

## Recover from a failed route

When real business traffic fails at the selected proxy, the native dialog can permit another attempt, use Default once, open Settings → Network & Runtimes, or dismiss the incident. **Retry** permits another attempt at the same selected route; re-run the affected operation yourself. **Use Default This Time** restarts with a one-use override and keeps the saved mode. **Open Network Settings** opens the main window at the Network section and shows the unresolved failure without changing mode.

The page also shows the last unresolved proxy failure and offers the same route retry. Tests do not create that failure. System policy changes and an explicit Reload start a new epoch; a failed proxy does not authorize another route or Direct.

If you cancel a Basic proxy credential prompt, the failure remains visible. A later request that needs credentials can prompt again in the same epoch.

<a id="troubleshoot"></a>

## Troubleshoot

A failed selected proxy does not switch to another proxy or to Direct. Use the failure dialog to retry the same route, use Default once, or open Settings → Network & Runtimes. **Use Default This Time** restarts once and keeps the saved mode.

If Save reports that secure storage is unavailable, the new password is not written. Enable Secret Service or KWallet on Linux, then save the password again. `basic_text` is not persistent storage.

System mode on an unsupported Linux desktop fails closed. Use Manual or Direct. GNOME and KDE 5/6 are the supported Linux policy sources.

A local proxy application that only changes operating-system proxy settings is followed in System Proxy mode. Default, and the command-line `dsh` process, still use `HTTP_PROXY` and `HTTPS_PROXY`.

<a id="compatibility"></a>

## Compatibility

| Client or policy | Desktop mode | What Desktop executes |
| --- | --- | --- |
| Mihomo, Clash Verge Rev, or Sparkle mixed port | Manual HTTP to that single port | One HTTP upstream for ordinary requests and CONNECT |
| Ordinary SOCKS5 proxy | Manual SOCKS5 | No-auth SOCKS5; the proxy resolves the target name |
| Operating-system proxy, PAC, or WPAD | System Proxy | The first final route only, including an explicit `DIRECT` |
| No proxy | Direct | Explicit direct, and Agent proxy variables are cleared |

Windows reads current-user WinHTTP settings. macOS reads CFNetwork. Linux reads GNOME GSettings or KDE 5/6 `kioslaverc`. Integrated NTLM and Negotiate authentication, SOCKS5 passwords, and Manual bypass are unsupported. Desktop CI runs the runtime on Windows, macOS, and Linux. The Windows installer smoke requires `resources/network-runtime/dsh-electron-network-runtime.exe`. Signed macOS Keychain behavior and an enterprise WPAD laboratory remain operator checks.

<a id="limits"></a>

## Limits

Manual bypass, SOCKS5 authentication, custom HTTPS proxy CAs, client certificates, and integrated proxy authentication are unsupported. An unsupported System backend fails closed. See [Network Runtime](network-runtime.md) for platform policy, authentication, and transport details.

## Dev Note

None.
