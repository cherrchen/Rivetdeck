# Agent Note: Electron deletes the Details Host mirror

Status: implemented

English | [中文](2026-09-13-electron-remove-details-host.zh.md)

## Problem

Upstream `dsh-v0.1.5-rc.2` removed the Client `details` slot, so `@dsh-electron/dsh-client-ui-details-host` has no column left to host. The unmounted subtree mirror at `apps/electron/runtime/plugins/ui-details-host` still targets the removed API: it registers a `details` occupant and calls `ctx.layout.openDetails()` / `closeDetails()`, neither of which exists on the current `ILayout`. Because `tsconfig.runtime-client.json` includes every `runtime/plugins/*/src/client` tree, Desktop type-checks this source against workspace types, and the mirror's published 0.1.2-rc.1 `peerDependencies` keep it a consumer of the API upstream deleted. An installed or ignored nested `node_modules` resolves those peers to old declaration files and hides the breakage locally; a clean tree — CI — exposes it.

## Decision

The mirror is deleted. This repository contains no `ui-details-host` directory, no `@dsh-electron/dsh-client-ui-details-host` dependency, no dedicated Electron integration test, and no client path alias for the package.

The removed surface stays absent: the published Git package uses `sidebarRight` and is inserted by the Desktop Host patch. Nothing in the runtime plugin inventory or reserved package names references Details Host.

Reintroduction requires a Client occupancy slot (Sidebar or a restored Details column) and a consumer, and starts from the canonical `cherrchen/dsh-client-ui-details-host` repository, re-added as a git subtree mirror. This note consolidates and replaces the 2026-09-13 Details Host unmount note; the unmount decision is preserved here rather than as a separate record.

## Alternatives considered

**Exclude the mirror from `tsconfig.runtime-client.json`.** Rejected because an excluded tree is type-checked by no program, so its source rots silently while the runtime plugin inventory, discovery tests, and packaging still carry it.

**Keep the unmounted tree.** Rejected after the type-check incident: it needed the exclusion workaround, its subtree history and the canonical repository keep the source restorable, and the [Sidebar composition note](2026-09-13-electron-plugin-manager-and-git-sidebar.md) removed its last consumer when Git moved to `sidebarRight`.

**Reimplement Details Host on the current layout API.** Rejected because the upstream Client offers no third column or details service to host; that is an upstream product decision, not a Desktop mirror patch.

## Consequences

`apps/electron/tsconfig.runtime-client.json` compiles only local runtime plugin client trees, so CI type-checks that inventory and a nested stale dependency can no longer hide a workspace API break. Theme Studio and Git are profile-managed ecosystem bundles ([profile ownership note](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.md)); the [required portable UI infrastructure](2026-08-24-electron-required-portable-ui-infrastructure.md) category has no current member.
