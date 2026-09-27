# Agent Note: Desktop uses Web Plugin Manager and composes Git through sidebarRight

Status: implemented

English | [中文](2026-09-13-electron-plugin-manager-and-git-sidebar.zh.md)

## Problem

The 0.1.5-rc.2 pin left Plugin Manager and Git uncomposed because Git occupied the removed Client `details` slot ([Git unmount](2026-09-13-electron-unmount-git-plugin.md)). `settings.plugins.tab` still exists, so the Installed tab could remount without Details Host. Git needed a Sidebar port before it could return to `dshElectron.ecosystemPlugins`.

## Decision

The Web profile mounts the upstream Plugin Manager. Desktop's Host patch does not insert a separate Electron manager.

`@dsh-electron/dsh-plugin-git@0.2.3` injects `sidebarRight` / `sidebarRightTabs` and has no runtime dependency on `details`, `shellDetails`, or `@dsh-electron/dsh-client-ui-details-host`. Desktop lists the package in `dshElectron.ecosystemPlugins` and keeps its exact production npm dependency under the [npm-only ecosystem plugin rule](2026-09-14-electron-npm-only-ecosystem-plugins.md).

## Alternatives considered

**Remount Details Host so the previous Git client could load.** Rejected because upstream still has no `details` slot.

**Remount Plugin Manager while leaving Git uncomposed after the Sidebar port landed.** Rejected because the port is details-free and `sync-version` can keep the production dependency.

**Delete the Details Host tree.** Rejected at the time because subtree identity remained useful while the slot was absent. The mirror is since deleted ([removal note](2026-09-13-electron-remove-details-host.md)).

## Consequences

The upstream Plugin Manager provides the Installed view. Git UI lives in the right sidebar. Desktop seeds the Git package into the web profile; `host.patch.yml` does not insert it.

See [profile-managed ecosystem plugins](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.md) for seed, Disable versus Uninstall, and ownership overlay rules.
