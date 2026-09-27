# Agent Note: Electron seeds ecosystem plugins into the web profile and dedupes by ownership

Status: implemented

English | [中文](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.zh.md)

## Problem

Desktop needed Git on the official Plugins page with Enable/Disable, without changing `packages/` or the upstream Plugin Manager, and without the Host overlay remounting Git after Disable. CLI install and the Plugins page were two stories for the same write. A same-named package already in `$DSH_HOME` could prevent Desktop from starting.

## Decision

Electron does not edit `packages/`, `apps/web`, or upstream `docs/`. Required overlay names come from static `host.patch.yml` inserts, not from the Official roster. Official `plugins.item` cards are Desktop Capabilities and Theme Studio; the Capabilities detail page lists product Components. Ecosystem plugins such as Git are seeded into `$DSH_HOME/profiles/web` as a pinned dependency and, on first seed, as an enabled bundle. `dsh plugin` and the Plugins page are the same profile-managed path.

The ownership overlay scans bundle layers, `profiles/web/cordis.patch.yml`, and `$DSH_HOME/cordis.patch.yml` — the `readProfilePatches()` order before `--patch` and telemetry. Required names disable every pre-Electron copy, then the static overlay inserts one Desktop canonical row. An enabled ecosystem package keeps the row its own `dsh.bundle.patch` inserts; extra same-name rows are disabled. A disabled ecosystem package gets no overlay insert. The overlay never inserts Git.

Disable persists in `dsh.profile.bundles`. Uninstall drops the dependency; the next Desktop boot seeds and enables it again. Electron does not hide Uninstall. Every boot restores Desktop-owned links under `profiles/node_modules` and `profiles/web/node_modules`.

Required `plugins.item` copy is Built into Desktop / Required by Desktop. The Official cards and the Capabilities Components list are a product roster, not a dump of Loader rows. Live component phase is recorded in [Desktop Capabilities composition root](2026-09-27-electron-desktop-capabilities-composition-root.md).

This extends [Web Plugin Manager and Git sidebar](2026-09-13-electron-plugin-manager-and-git-sidebar.md) and keeps the [npm-only ecosystem plugin](2026-09-14-electron-npm-only-ecosystem-plugins.md) distribution rule.

## Alternatives considered

**Add `locked` or `source=desktop` to the upstream Plugin Manager.** Rejected because Desktop must not change `packages/` and the Plugins page already distinguishes Official `plugins.item` cards from Installed bundles.

**Keep Git as a `host.patch.yml` insert.** Rejected because Disable cannot unmount a later overlay insert.

**Disable every pre-Electron row whose `name` matches Git.** Rejected because that would disable the bundle's own canonical `dsh-plugin-git` row.

**Hide Uninstall for seeded ecosystem plugins.** Rejected because it would add a second management system; re-seed on the next Desktop boot is the accepted recovery.

**Write Desktop-only runtime rows into the shared web profile.** Rejected because those rows are not portable; CLI `dsh web` in the same `$DSH_HOME` must not load Electron adapters.

## Consequences

Git is visible to CLI `dsh web` that shares `$DSH_HOME`. Uninstall is temporary until the next Desktop start. Session-time `pnpm` rebuilds of `node_modules` are not repaired until the next boot. Duplicate-id disable-then-insert for required plugins can leave a disabled predecessor beside the overlay row; one active canonical copy remains.
