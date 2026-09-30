# Electron Plugin Composition

English | [中文](plugin-lifecycle.zh.md)

> Status: **Current downstream reference**
>
> Scope: `apps/electron/**`, `apps/electron/runtime/**`
>
> Audience: maintainers, coding agents, reviewers, and future contributors

## Purpose

Desktop combines Electron-owned packages with ordinary profile-owned plugins. The shared web profile owns package persistence and user activation intent. Electron Installed reports the effective ecosystem and profile bundle inventory, including disabled packages, using resolved package metadata and live Loader/Fiber state.

## Plugin classes

**Profile-managed.** `dsh plugin` and the Plugins page write `$DSH_HOME/profiles/web` through upstream package operations. An ordinary third-party bundle outside Electron’s declared owned set participates in Electron composition and resolves to the profile package. External CLI add, remove, and update operations trigger live reconciliation; removing that package unloads its Loader entries and removes its Installed card.

**Desktop-required.** Directories under `runtime/plugins/`, packages listed in `dshElectron.runtimePlugins`, and required overlay adapters (including `directory-picker-browse`) are application composition. Electron's overlay always mounts them. These plugins cannot be turned off and do not appear as separate Installed cards. Their Loader rows remain available through the plugin inventory.

Desktop-required is not one Official card per package. Keep four facts separate: the composition package, internal features, independent Host adapters, and portable runtime or ecosystem plugins.

**Composition package.** `@dsh-electron/dsh-electron-desktop-capabilities` is one Loader/npm package with one `lib/client.js`. It provides `ctx.desktop` and mounts internal features through Cordis `ctx.plugin()`. It is not `immediately: true`; `ctx.desktop` activates with the application batch.

**Internal features.** Directory picker, brand, network settings, and plugin-manager live under `desktop-capabilities/src/client/features/`. They are child fibers with their own `name` / `inject` / `apply`, not Loader rows and not npm packages.

**Independent Host adapters.** `desktop-network-subprocess` and upstream `directory-picker-browse` remain their own Loader rows. Network subprocess stays a Host-only provider.

**Portable runtime / ecosystem.** Theme Studio and Git are ecosystem bundles on the Installed group. The published Theme Studio package supplies its own Client UI; Desktop Capabilities does not register it.

The Plugins page registers an Official `plugins.item` card only for Desktop Capabilities from the composition package. Desktop Capabilities' detail page shows its version, a Desktop tag, the package name, and a short description, then lists product Components (network access, the system folder window, the workspace folder picker, the app icon and name, and network settings) under the same contained-components heading and count a bundle uses. Each Capabilities row shows that sentence, a short id, and a package specifier: `@dsh-electron/dsh-electron-desktop-capabilities/<feature>` for internal features, and the independent npm name for Loader-backed adapters. Host `pluginInventory/list` supplies phase for Loader-backed rows; Client feature fibers supply phase for directory-picker, brand, and network-settings. The Capabilities entry cannot be enabled, disabled, or uninstalled.

**Desktop-preinstalled ecosystem.** On the first Desktop start, the shared `dsh plugin` package operation installs missing packages listed in `dshElectron.ecosystemPlugins` (Git and Theme Studio) at their bundled exact versions. That operation owns the web profile manifest, lockfile, and installed packages; new bundles start enabled. Existing dependency versions and Disable selections remain intact. A completed preinstall is recorded outside the profile, so a later Uninstall removes the shared installation without a subsequent reinstall. The same package operation repairs ecosystem links left by older Desktop releases. CLI `dsh web` loads only the profile-installed copy. The supervised Desktop Host loads Electron-bundled copies through `$DSH_HOME/electron/host-profile`; after a profile Uninstall, its private bundle list still activates the bundled copy. An installed but disabled bundle stays disabled in both hosts. Installed reports the bundled runtime version and source, independently of the CLI/profile copy. Electron-owned packages cannot be uninstalled from the application; CLI removal affects only profile persistence. Enable/Disable remains available, including after profile removal, through profile patches targeting bundled Loader rows.

## Startup composition

Startup runs, in order: migrate legacy plugin state; discover and validate bundled artifacts; link required runtime plugins into shared profile resolution; run any initial ecosystem preinstall and legacy-link repair through `dsh plugin`; materialize the Host profile projection; write the ownership-aware Host overlay; start the Desktop Host entry with that overlay. A failed package operation stops Desktop startup with its diagnostic.

The shared package operation holds the web profile `package.json` writer lock and updates its manifest and lockfile. Desktop's preinstall marker lives under `$DSH_HOME/electron`.

Every Electron boot restores Desktop-owned package links for **required runtime plugins only** under `$DSH_HOME/profiles/node_modules` and `$DSH_HOME/profiles/web/node_modules`. Ecosystem packages are never symlinked into those shared trees. The Host resolution projection under `$DSH_HOME/electron/host-profile` forwards ordinary web packages, points ecosystem names at Electron-bundled directories, and selects removed ecosystem names only for that Host process. Desktop exit leaves the shared web profile untouched; no restore step runs.

`DesktopRuntime` owns startup and subsequent composition generations. Desktop Capabilities registers watches for the shared profile manifest, lockfile, activation patch, compatibility file, and home patch on the existing HMR queue. Reconciliation takes the profile writer lock after a CLI/package operation releases it, refreshes the private projection, unloads removed or replaced package entries, invalidates package lookup caches, and awaits Loader settlement. The upstream HMR profile reader is isolated so it cannot recompose from the persistence directory. The private directory contains disposable projection files, without a separate package database or lockfile. For each required package, every pre-overlay row is disabled and the static overlay inserts its Desktop row. For an enabled ecosystem package, the applied bundle layer's own row remains active and extra same-name rows are disabled. For a disabled ecosystem package, extra same-name rows remain disabled. The overlay inserts neither Git nor Theme Studio. A disable whose id is absent stays an include warning; Main does not fail.

Theme Studio is installed from npm as `@dsh-electron/dsh-theme-studio@0.1.3` and declared in `dshElectron.ecosystemPlugins`. Its published peer declarations include `0.1.7-rc.2`. A missing bundled artifact stops startup with an error.

The upstream Web bundle mounts its own Plugin Manager UI and agent tool. Main places the packaged pnpm executable on the supervised Host `PATH` so the upstream profile manager can run package commands without a global pnpm installation. On the first launch after upgrading, Main transfers entries from the legacy `$DSH_HOME/electron/plugin-state.json` `profileManaged` list into `$DSH_HOME/profiles/web/cordis.patch.yml`, retaining each entry's disabled state. The old file remains for recovery; a migration marker prevents a later user removal from being reversed. A missing installed package stops migration before Host startup, leaving the old file and patch available for repair.

## Boundaries

`ctx.desktop` exposes OS capabilities to Desktop-aware plugins. It has no plugin management group. The Renderer receives Host plugin scripts and RPC through the existing Main transport. The Desktop Host disables the upstream manager Loader row and inserts `DesktopPluginManager` as an explicit builtin. It retains upstream package operations against `ProfileContext.dir = web`, reports effective package versions and localized source labels, and joins bundle declarations to actual Loader entries. The shared UI honors the Host’s removal permission. Support diagnostics at `$DSH_HOME/electron/runtime-inventory.json` record resolved package and module paths, versions, sources, enablement, and Loader/Fiber states; they are observations, never configuration.
