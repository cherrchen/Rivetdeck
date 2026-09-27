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

**Desktop-required.** Directories under `runtime/plugins/`, packages listed in `dshElectron.runtimePlugins`, and required overlay adapters (including `directory-picker-browse` and Theme Studio) are application composition. Electron's overlay always mounts them. These plugins cannot be turned off.

Desktop-required is not one Official card per package. Keep four facts separate: the composition package, internal features, independent Host adapters, and portable runtime or ecosystem plugins.

**Composition package.** `@dsh-electron/dsh-electron-desktop-capabilities` is one Loader/npm package with one `lib/client.js`. It provides `ctx.desktop` and mounts internal features through Cordis `ctx.plugin()`. It is not `immediately: true`; `ctx.desktop` activates with the application batch.

**Internal features.** Directory picker, brand, network settings, and plugin-manager live under `desktop-capabilities/src/client/features/`. They are child fibers with their own `name` / `inject` / `apply`, not Loader rows and not npm packages.

**Independent Host adapters.** `desktop-network-subprocess` and upstream `directory-picker-browse` remain their own Loader rows. Network subprocess stays a Host-only provider.

**Portable runtime / ecosystem.** Theme Studio is a required npm runtime plugin with its own Official card. Git is an ecosystem bundle on the Installed group.

The Plugins page registers Official `plugins.item` cards only for Desktop Capabilities and Theme Studio, with Built into Desktop / Required by Desktop copy. The Capabilities detail page lists product Components (network subprocess, directory picker backend, directory picker, brand, network settings) in the same contained-components heading and count used by a bundle's parts list. Host `pluginInventory/list` supplies phase for Loader-backed rows; Client feature fibers supply phase for directory-picker, brand, and network-settings. Entries cannot be enabled, disabled, or uninstalled.

**Desktop-preinstalled ecosystem.** Packages listed in `dshElectron.ecosystemPlugins` (currently Git) are written into the web profile as a pinned `dependencies` entry and, on first seed, into `dsh.profile.bundles`. They appear as Installed/Bundle cards, not Official `plugins.item` cards. Enable and Disable persist in `dsh.profile.bundles`. Uninstall removes the dependency; the next Desktop boot seeds it again and enables it. Git is a portable bundle, so CLI `dsh web` in the same `$DSH_HOME` also sees it.

## Startup composition

Startup runs, in order: migrate legacy plugin state; discover Desktop-owned inventory; validate bundled artifacts; seed ecosystem dependencies (a new dependency is enabled, an existing dependency keeps its bundle selection); restore Desktop-owned package links; load the pre-Electron composition (bundle layers, `profiles/web/cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`); write an ownership-aware overlay; start `dsh web --patch electron-host.patch.yml`.

Every Electron boot restores Desktop-owned package links under `$DSH_HOME/profiles/node_modules` and `$DSH_HOME/profiles/web/node_modules` to the application copies. Session-time Plugin Manager `pnpm add/remove/install` rebuilds of `node_modules` are not repaired until the next boot.

The ownership overlay scans the same layers `readProfilePatches()` uses before `--patch` and telemetry. A missing web profile or home patch is an empty layer and does not fail startup. For each required package, every pre-Electron row is disabled and the static overlay inserts the single Desktop canonical row. For an enabled ecosystem package, the row its own `dsh.bundle.patch` inserts is kept and extra same-name rows from the user or home patch are disabled. For a disabled ecosystem package, no overlay insert is added, the bundle layer is absent, and extra same-name rows are still disabled. The overlay never inserts Git. A disable whose id is absent stays an include warning; Main does not fail.

Theme Studio is installed from npm as `@dsh-electron/dsh-theme-studio@0.1.1` and declared in `dshElectron.runtimePlugins`. Its published peer declarations include `0.1.7-rc.2`. A missing bundled artifact stops startup with an error.

The upstream Web bundle mounts its own Plugin Manager UI and agent tool. Main places the packaged pnpm executable on the supervised Host `PATH` so the upstream profile manager can run package commands without a global pnpm installation. On the first launch after upgrading, Main transfers entries from the legacy `$DSH_HOME/electron/plugin-state.json` `profileManaged` list into `$DSH_HOME/profiles/web/cordis.patch.yml`, retaining each entry's disabled state. The old file remains for recovery; a migration marker prevents a later user removal from being reversed. A missing installed package stops migration before Host startup, leaving the old file and patch available for repair.

## Boundaries

`ctx.desktop` exposes OS capabilities to Desktop-aware plugins. It has no plugin management group. The Renderer receives Host plugin scripts and RPC through the existing Main transport. Electron does not hide Uninstall for ecosystem plugins and does not add `locked` or `source=desktop` fields to the upstream Plugin Manager.
