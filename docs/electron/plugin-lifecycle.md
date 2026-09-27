# Electron Plugin Composition

English | [中文](plugin-lifecycle.zh.md)

> Status: **Current downstream reference**
>
> Scope: `apps/electron/**`, `apps/electron/runtime/**`
>
> Audience: maintainers, coding agents, reviewers, and future contributors

## Purpose

Desktop mounts its required adapters and bundled Git plugin while the upstream Web profile manages user-installed plugins.

## Startup composition

`runtime/host.patch.yml` mounts the Desktop Capability Provider, directory picker client, brand, Network Settings, Theme Studio, and the bundled Git plugin. Theme Studio is installed from npm as `@dsh-electron/dsh-theme-studio@0.1.1` and declared in `dshElectron.runtimePlugins`. Its published peer declarations include `0.1.7-rc.2`. Main validates every bundled Host and Client artifact and links the packages under `$DSH_HOME/profiles/node_modules` before starting `dsh web`. A missing artifact stops startup with an error.

The upstream Web bundle mounts its own Plugin Manager UI and agent tool. Main places the packaged pnpm executable on the supervised Host `PATH` so the upstream profile manager can run package commands without a global pnpm installation. On the first launch after upgrading, Main transfers entries from the legacy `$DSH_HOME/electron/plugin-state.json` `profileManaged` list into `$DSH_HOME/profiles/web/cordis.patch.yml`, retaining each entry's disabled state. The old file remains for recovery; a migration marker prevents a later user removal from being reversed. A missing installed package stops migration before Host startup, leaving the old file and patch available for repair. After migration, plugin enablement follows the Web profile patch. Electron does not maintain a separate live plugin state file or dynamic Cordis include.

## Boundaries

`ctx.desktop` exposes OS capabilities to Desktop-aware plugins. It has no plugin management group. The Renderer receives Host plugin scripts and RPC through the existing Main transport. The Desktop Host overlay lists bundled plugins statically; user-installed bundles are composed by the upstream profile.
