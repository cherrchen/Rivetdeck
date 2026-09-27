# Electron Plugin Composition

English | [中文](plugin-lifecycle.zh.md)

> Status: **Current downstream reference**
>
> Scope: `apps/electron/**`, `apps/electron/runtime/**`
>
> Audience: maintainers, coding agents, reviewers, and future contributors

## Purpose

Desktop classifies plugins by who owns enablement. Profile-managed plugins use the upstream Plugin Manager. Desktop-required plugins are part of the application. Desktop-preinstalled ecosystem plugins ship enabled and remain user-switchable on the Installed group.

## Plugin classes

**Profile-managed.** `dsh plugin` and the official Plugins page are different entries into the same web profile. Both write `$DSH_HOME/profiles/web`. The upstream Plugin Manager owns install, enable, disable, and uninstall.

**Desktop-required.** Directories under `runtime/plugins/`, packages listed in `dshElectron.runtimePlugins`, and required overlay adapters (including `directory-picker-browse`) are application composition. Electron's overlay always mounts them. These plugins cannot be turned off.

Desktop-required is not one Official card per package. Keep four facts separate: the composition package, internal features, independent Host adapters, and portable runtime or ecosystem plugins.

**Composition package.** `@dsh-electron/dsh-electron-desktop-capabilities` is one Loader/npm package with one `lib/client.js`. It provides `ctx.desktop` and mounts internal features through Cordis `ctx.plugin()`. It is not `immediately: true`; `ctx.desktop` activates with the application batch.

**Internal features.** Directory picker, brand, network settings, and plugin-manager live under `desktop-capabilities/src/client/features/`. They are child fibers with their own `name` / `inject` / `apply`, not Loader rows and not npm packages.

**Independent Host adapters.** `desktop-network-subprocess` and upstream `directory-picker-browse` remain their own Loader rows. Network subprocess stays a Host-only provider.

**Portable runtime / ecosystem.** Theme Studio and Git are ecosystem bundles on the Installed group. The published Theme Studio package supplies its own Client UI; Desktop Capabilities does not register it.

The Plugins page registers an Official `plugins.item` card only for Desktop Capabilities from the composition package. Desktop Capabilities' detail page shows its version, a Desktop tag, the package name, and a short description, then lists product Components (network access, the system folder window, the workspace folder picker, the app icon and name, and network settings) under the same contained-components heading and count a bundle uses. Each Capabilities row shows that sentence, a short id, and a package specifier: `@dsh-electron/dsh-electron-desktop-capabilities/<feature>` for internal features, and the independent npm name for Loader-backed adapters. Host `pluginInventory/list` supplies phase for Loader-backed rows; Client feature fibers supply phase for directory-picker, brand, and network-settings. The Capabilities entry cannot be enabled, disabled, or uninstalled.

**Desktop-preinstalled ecosystem.** Packages listed in `dshElectron.ecosystemPlugins` (Git and Theme Studio) are written into the web profile as pinned `dependencies` and, on first seed, into `dsh.profile.bundles`. They appear as Installed/Bundle cards. Enable and Disable persist in `dsh.profile.bundles`. Uninstall removes a dependency; the next Desktop boot seeds and enables it again. CLI `dsh web` in the same `$DSH_HOME` also sees these portable bundles.

## Startup composition

Startup runs, in order: migrate legacy plugin state; discover and validate bundled artifacts; restore Desktop-owned package links; seed ecosystem dependencies (a new dependency is enabled, an existing dependency keeps its bundle selection); write the ownership-aware Host overlay; start `dsh web --patch electron-host.patch.yml`.

Every Electron boot restores Desktop-owned package links under `$DSH_HOME/profiles/node_modules` and `$DSH_HOME/profiles/web/node_modules` to the application copies. An existing physical package directory is preserved beside the new link with a `.desktop-replaced-<id>` suffix. Session-time Plugin Manager `pnpm add/remove/install` rebuilds of `node_modules` are not repaired until the next boot.

Desktop Capabilities' Host half refreshes the ownership overlay whenever profile HMR recomposes layers. For each required package, every pre-overlay row is disabled and the static overlay inserts its Desktop row. For an enabled ecosystem package, its own bundle row remains active and extra same-name rows are disabled. For a disabled ecosystem package, extra same-name rows remain disabled. The overlay inserts neither Git nor Theme Studio. A disable whose id is absent stays an include warning; Main does not fail.

Theme Studio is installed from npm as `@dsh-electron/dsh-theme-studio@0.1.2` and declared in `dshElectron.ecosystemPlugins`. Its published peer declarations include `0.1.7-rc.2`. A missing bundled artifact stops startup with an error.

The upstream Web bundle mounts its own Plugin Manager UI and agent tool. Main places the packaged pnpm executable on the supervised Host `PATH` so the upstream profile manager can run package commands without a global pnpm installation. On the first launch after upgrading, Main transfers entries from the legacy `$DSH_HOME/electron/plugin-state.json` `profileManaged` list into `$DSH_HOME/profiles/web/cordis.patch.yml`, retaining each entry's disabled state. The old file remains for recovery; a migration marker prevents a later user removal from being reversed. A missing installed package stops migration before Host startup, leaving the old file and patch available for repair.

## Boundaries

`ctx.desktop` exposes OS capabilities to Desktop-aware plugins. It has no plugin management group. The Renderer receives Host plugin scripts and RPC through the existing Main transport. Electron does not hide Uninstall for ecosystem plugins and does not add `locked` or `source=desktop` fields to the upstream Plugin Manager.
