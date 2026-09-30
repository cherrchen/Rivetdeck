# Agent Note: Electron ecosystem runtime ownership is process-local

Status: implemented

English | [中文](2026-09-29-electron-process-local-ecosystem-runtime-ownership.zh.md)

## Problem

Desktop linked `dshElectron.ecosystemPlugins` into shared `$DSH_HOME/profiles/node_modules` and `profiles/web/node_modules` on every boot. That made Electron own profile package persistence, so `dsh plugin --profile web list` could disagree with the Host runtime, and concurrent CLI `dsh web` could import Desktop-bundled copies. Required runtime plugins still need Desktop-owned shared links; ecosystem plugins must not.

Upstream `packages/boot/app-boot` cannot gain a Desktop-only override in this downstream change. Desktop must keep process-local runtime ownership without rewriting shared profile packages.

## Decision

Split three ownership axes:

- **Persistence** stays on the shared web profile (`package.json`, lock, `node_modules`). The shared `dsh plugin` operation preinstalls missing packages once and repairs legacy Desktop links; it owns manifest, lockfile, and package writes. User removal persists in the shared profile; Desktop still selects its bundled copy in the private Host projection.
- **Activation** uses each host's bundle list. An installed but disabled ecosystem dependency remains disabled in both hosts. A removed dependency remains absent for CLI, while Desktop selects the bundled copy only in its private Host manifest.
- **Runtime implementation** is process-local. CLI resolves the profile-installed copy. The supervised Desktop Host boots through `apps/electron/src/host.ts`, builds `$DSH_HOME/electron/host-profile` (outside `profiles/`), forwards ordinary web packages, and points ecosystem names at Electron-bundled directories. `ProfileContext.dir` remains the shared web profile for persistence operations. `DesktopRuntime` owns composition and resolution; `DesktopPluginManager` reports the effective runtime inventory with actual package metadata and Loader state.

`ensureRuntimePluginsLinked` links only required runtime plugins. The ownership overlay continues to suppress duplicate Cordis rows and never selects the physical package source. Canonical ecosystem ids come from the applied Host projection layer when present.

A future upstream `RuntimePackageOverride` in app-boot can replace the private projection; until then Desktop keeps the projection under `$DSH_HOME/electron/host-profile`.

This updates the profile seeding and filesystem ownership described in [Electron profile-managed ecosystem and ownership overlay](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.md). Enable/Disable and overlay dedupe from that note remain.

## Alternatives considered

**Global profile-first `resolveBundleDir`.** Rejected because in-box bundles must stay installation-owned.

**Startup backup and shutdown restore of shared packages.** Rejected because crash, kill, and concurrent CLI races leave the disk wrong.

**`NODE_PATH` or environment-wide package takeover.** Rejected because agent children would inherit Desktop ownership.

**Promote ecosystem plugins to required runtime plugins.** Rejected because users own Enable/Disable on the Installed group.

**Change `packages/boot/app-boot` in this downstream PR.** Rejected under AGENTS.downstream.md; Desktop-only work stays in `apps/electron/**` and `docs/electron/**`.

## Consequences

CLI and Desktop can run concurrently against the same web profile with different ecosystem package directories. `dsh plugin list` continues to report the profile-installed version. Desktop exit needs no shared-profile restore. External CLI mutations and UI operations reconcile on the existing HMR queue after the profile writer lock settles. Ordinary profile packages activate and unload live; ecosystem packages retain bundled implementation, patch, and version after profile removal. The projection has no independent package operations or lockfile.
