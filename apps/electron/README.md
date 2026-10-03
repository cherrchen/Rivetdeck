# DeepSeek Harness Desktop

English | [中文](README.zh.md)

This application packages the upstream DeepSeek Harness as a native desktop shell. Electron Main supervises the built `dsh web` backend on a loopback port for compatibility, while `BrowserWindow` loads an Electron-owned renderer from `dsh-electron://localhost/` built inside this package from `@deepseek-ai/dsh-client-web`. Host bootstrap, plugin bundles, unary Host calls (including plugin-owned Connection RPC channels), and event streams reach the supervised process only through Main (typed preload IPC and the custom-scheme protocol proxy). Profiles, sessions, and `$DSH_HOME` storage remain the upstream Harness behavior.

Detailed CURRENT vs TARGET architecture, ownership rules, milestones, and ADRs live in [../../docs/electron/architecture.md](../../docs/electron/architecture.md).

## Architecture (CURRENT)

Desktop separates three layers:

| Layer | Owns |
| ----- | ---- |
| Electron Runtime | Window/tray/menu/updater, OS privileges, security policy, Host process supervision, packaging |
| DeepSeek Harness | Agents, sessions, tools, models, profiles, Cordis Host/client runtime, persistence |
| Feature plugins | Portable or Desktop-aware product features packaged as standard DSH plugins |

Process topology:

```text
BrowserWindow (dsh-electron://localhost)
  └─ Electron-owned Renderer → @deepseek-ai/dsh-client-web
Electron Main
  ├─ typed window.deepseekDesktop bridge (no generic IPC)
  └─ supervised `dsh web` on 127.0.0.1:<random-port>
```

Governing rules for contributors:

- Desktop-only work stays under `apps/electron/**`; do not customize Desktop UI through `apps/web`.
- Keep `src/renderer` a thin bootstrap/carrier; do not grow a second product frontend there.
- Portable and Desktop-aware product features belong in independently published DSH/Cordis packages; `runtime/plugins/` holds the Desktop Capabilities composition package and Host-only providers. Desktop-required Host composition is listed in `runtime/host.patch.yml`; bundled Git and Theme Studio are seeded into the web profile ([plugin lifecycle](../../docs/electron/plugin-lifecycle.md)).
- A Desktop-aware feature keeps its core fiber portable and installs native enhancements through an optional `ctx.inject(['desktop'], ...)` child fiber. It consumes the `ctx.desktop` capability service, never `window.deepseekDesktop` directly.
- Loopback Host transport is an internal compatibility mechanism, not a defect to remove without evidence.

## Development

Use Node.js and pnpm versions declared by the repository. Build the upstream runtime before starting Electron:

```sh
pnpm install
pnpm run build
pnpm --filter @dsh-electron/dsh-electron start
```

`pnpm --filter @dsh-electron/dsh-electron build` compiles the main process, preload bridge, bundled runtime plugins, and renderer (`dist/renderer`). Focused desktop tests expect those Electron artifacts (after the upstream `pnpm run build` above):

```sh
pnpm --filter @dsh-electron/dsh-electron build
pnpm --filter @dsh-electron/dsh-electron test
pnpm --filter @dsh-electron/dsh-electron test:ownership
```

The Electron application is a private installer, not an npm release member. Its dependency sync copies upstream CLI workspace dependencies using `workspace:^`, excludes experimental peers, and retains stable peers required by optional bundles; the repository's `constraints` check applies that range to this application and keeps the upstream publication rules on upstream packages.

Repository Python integration tests require CPython 3.10+ selected by `python3` on PATH. If mise reports an inactive shim, activate an installed version for the command, for example `mise exec python@3.13.12 -- pnpm test packages/experimental/code-runtime-python/tests/runtime.spec.ts packages/experimental/code-runtime-python/tests/boot-write-failure.spec.ts`. Use a version installed on your machine; `python3 --version` must succeed before running the tests.

The independent [Network Runtime](../../docs/electron/network-runtime.md) provides a loopback Gateway for Manual HTTP, HTTPS, SOCKS5, and strict System policy routing. Its verification command and integration limits are documented there.
The [Network Settings guide](../../docs/electron/network-settings.md) covers the Settings page, connection tests, secure storage prompts, and diagnostics.

## Desktop integration

The main window uses a hidden title bar without a separate heading row. The sidebar background extends to the window top: macOS reserves a draggable sidebar inset for its traffic lights, and Windows and Linux start the columns right of the sidebar below the native control row, leaving that band blank and draggable; the fullscreen right panel reserves the same kind of row inside its own box. Unused parts of the active conversation header are draggable, and a transparent hit surface covers the empty-session background and the blank band. Header controls are explicitly non-draggable, and every page drag region is suspended while a modal dialog is open so its mask and controls retain pointer input. Closing the main window hides it while the Harness process continues running. Use the tray menu to reopen the window or quit the application and stop the supervised process.

OS desktop capabilities are owned by Electron Main and exposed through the typed `window.deepseekDesktop` preload bridge. The Desktop Capabilities package (`runtime/plugins/desktop-capabilities`) adapts that bridge into `ctx.desktop`, mounts Desktop Client features, and refreshes the Host ownership overlay during profile HMR. The supervised Host receives a generated `electron-host.patch.yml` that mounts the required Desktop Loader rows. At startup, Main validates bundled artifacts, links required runtime plugins into `$DSH_HOME/profiles/node_modules` and `$DSH_HOME/profiles/web/node_modules`, uses the shared dsh plugin package operation to preinstall missing ecosystem bundles including Git and Theme Studio once and repair old Desktop links, and materializes `$DSH_HOME/electron/host-profile` so the Host resolves ecosystem packages to Electron-bundled copies without rewriting shared profile packages. It transfers previously Desktop-managed runtime plugins into the Web profile patch once, preserving their enabled or disabled state. The shared web profile owns package persistence; DesktopRuntime owns mixed runtime composition and live CLI reconciliation, and DesktopPluginManager supplies effective ecosystem and profile bundles to the upstream Installed list; required Desktop components appear under Official → Desktop Capabilities; Main provides the packaged pnpm executable on the Host `PATH`. `scripts/build-runtime-plugins.mjs` builds local Desktop plugins from source, while Theme Studio and Git retain their published Host and Client artifacts. Upstream UI clipboard writes use a renderer shim to reach Main. External URLs opened as new windows use `https:`, `http:`, or `mailto:`.

The bundled Desktop network subprocess plugin imports the installed `dsh-subprocess-local` and `dsh-subprocess` packages at runtime. They must share the Host's executable-not-found error class so terminal shell discovery can skip unavailable candidates.

The native page context menu exposes cut, copy, paste, select all, and reload according to Chromium's current editing capabilities; development builds also expose DevTools. The application menu and tray menu provide the desktop-owned About window, update channel selection, and manual update check.

The tray uses a monochrome DeepSeek glyph rasterized from the tracked `assets/tray/deepseek.svg` (LobeHub lobe-icons, MIT). `pnpm run build:tray` emits per-DPI PNGs under `build/tray/`; Windows and Linux select a black glyph for a light native theme and a white glyph for a dark native theme at the nearest packaged pixel size for the primary display scale factor, refreshing when Electron reports a theme or display-metrics change. macOS uses pre-rasterized template PNGs so the operating system controls menu-bar contrast.

The About window reads the repository URL from this package manifest, displays the packaged icon and version, and opens the project link in the system browser. Its renderer is sandboxed and its Content Security Policy admits only its embedded styles and icon.

## Updates

Packaged builds default to the **Pre-Release** channel and persist the selected channel in Electron's user-data directory. The application and tray menus can switch between **Pre-Release**, which receives the newest published prerelease or stable release, and **Stable / Release**, which uses GitHub's latest production release and never selects a prerelease. Channel selection uses GitHub Release metadata for tags such as `v0.1.0-beta.1`, `v0.1.0-rc.3`, and `v0.1.0`; `electron-updater` still owns metadata validation, semantic-version comparison, download, and installation.

The menus show checking and download progress, then offer a restart after the update is ready. Manual checks report whether no update exists or a download started. A failed check writes the complete error to the main-process log while its dialog contains only network and retry guidance.

`electron-builder` emits `latest.yml`, `latest-mac.yml`, architecture-specific Linux metadata, and blockmaps. The desktop release workflow merges per-architecture metadata before uploading it with the installers so one GitHub Release serves x64 and ARM64 clients. macOS auto-update installation requires signed packages; the repository's unsigned CI artifacts exercise metadata generation and download discovery but require signing credentials before trusted distribution.

## Packaging

The package metadata declares `DeepSeek Harness` as its product name, which Electron and `electron-builder` use for development chrome, application metadata, installers, and executables. Packaged metadata uses the unscoped `deepseek-harness-desktop` application name so updater cache directories never derive from the workspace-only `@dsh-electron/dsh-electron` name. The package configuration emits an assisted NSIS installer on Windows that lets users choose the installation directory and uses checked 7-Zip extraction of ZIP payloads to support package members beyond Windows MAX_PATH and reject failed extraction, plus DMG and ZIP artifacts on macOS and AppImage and DEB artifacts on Linux. Generated NSIS includes retain native Windows path separators so both installer and uninstaller compilation can resolve them. The release workflow builds every format for x64 and ARM64 on native GitHub-hosted runners; each Windows runner installs its completed artifact, verifies the executable, runtime, and both shortcuts, and launches the installed application with fresh user data, no managed runtimes, and an unreachable registry before uninstalling it and uploading. CI builds unsigned artifacts because repository signing credentials are not required; operators who distribute trusted binaries must provide the platform signing environment supported by `electron-builder`.

Desktop releases use `v{a.b.c}-beta.{x}` on `develop`, `v{a.b.c}-rc.{x}` on `main`, and `v{a.b.c}` for stable releases. [`sync-upstream.yml`](../../.github/workflows/sync-upstream.yml) merges upstream into `develop`, prepares and pushes the next Beta commit, and publishes its tag only after Desktop CI succeeds for that exact commit. Before opening the `develop` to `main` promotion pull request, run `pnpm electron:set-version <apps/cli version>` followed by `pnpm install --no-frozen-lockfile`, then commit the Electron manifest and lockfile. Desktop CI rejects a promotion from another branch, a Beta version, or a version that differs from [`apps/cli/package.json`](../cli/package.json). After the pull request merges, [`desktop-promote.yml`](../../.github/workflows/desktop-promote.yml) creates the RC or Stable tag on the prepared `main` commit without changing either branch. [`desktop-release.yml`](../../.github/workflows/desktop-release.yml) validates the tag branch and package version before publishing installers.

## Runtime and security

Electron Main loads versioned Desktop preferences before Host startup. The Network foundation retains the update channel during partial writes, defaults an invalid Network section without discarding a valid channel, encrypts Manual proxy passwords through `safeStorage`, rejects Linux `basic_text` persistence, consumes a one-use Default override, and centralizes Default, Direct, Managed-child, and opt-in Agent environment derivation. Default does not change an inherited child environment or Electron proxy configuration.

On macOS, startup reports Keychain storage as supported without accessing it. Saving a Manual proxy password or loading one configured for the active Manual route checks storage availability and may request Keychain access. A missing stored password does not access Keychain.

The release resources include the Rust Network Runtime at a fixed application-owned path. Manual and System start and configure its Gateway before Harness; Direct applies explicit Electron routing and clears controlled child proxy variables. Default leaves Electron proxy settings and inherited child environments untouched. With Agent proxying disabled, the Agent subprocess provider preserves inherited and Harness-home `.env` proxy values. The updater, upstream plugin commands, and Agent subprocess provider follow their distinct Desktop network policies; [Network Runtime](../../docs/electron/network-runtime.md) records the supported protocols and current limits.

The supervised Harness process binds only to `127.0.0.1` on a random port and is never the BrowserWindow page origin. The renderer has no Node.js integration, runs with context isolation and Chromium sandboxing, receives the typed `window.deepseekDesktop` bridge only, and cannot navigate away from `dsh-electron://localhost`. HTTP and HTTPS links requested as new windows open in the system browser.

On Windows the supervised process is the packaged Node.js runtime (`resources/core-runtime/node.exe`), started with `windowsHide` and an inherited stdin device handle so it holds one hidden console that agent shell commands such as `pwsh`, `git`, and `cmd` inherit instead of opening a Windows Terminal window; other platforms use Electron's Node-compatible child mode.

Desktop Core uses Electron on macOS/Linux and a Windows-only console executor containing `node.exe` and its license. The Host and plugin package manager use this Core executor independently of optional Agent runtimes. Node.js and Python are independently installed into versioned generations below Electron `userData/managed-toolchains`, through the optional setup dialog or Settings → Network & Runtimes. Skip is persisted separately from installation. Agent PATH searches request, project, user, and Main ambient values before managed fallbacks; an explicit PATH removal remains a removal. Only installed runtimes receive managed shims. Installation, update, and removal apply after restart, preserving running tasks. See [runtime environments](../../docs/electron/runtime-environments.md) for storage, network, and migration behavior.

Runtime downloads use fixed HTTPS archives and the SHA256 authority in [`toolchains.lock.json`](toolchains.lock.json). Main shares secure archive extraction with build preparation and verifies interpreter versions, npm/npx, Python imports, and pip before atomic activation. Release preparation uses `prepare:core`; complete managed distributions are excluded from installer resources.

Main preserves an explicit `$DSH_HOME`; otherwise the supervised process receives `.dsh` below the operating-system user home, so Harness profiles, settings, sessions, and other state use `~/.dsh` on macOS and Linux or `%USERPROFILE%\.dsh` on Windows. Electron keeps its Chromium data, caches, and desktop update preference in its platform-specific `userData` directory. Agent shell commands use the current user's home directory as their initial workspace; users can select another workspace through the Harness UI.

A Host startup timeout stops the supervised child before Desktop reports the failure. The upstream profile manager owns its package transactions and profile files.
