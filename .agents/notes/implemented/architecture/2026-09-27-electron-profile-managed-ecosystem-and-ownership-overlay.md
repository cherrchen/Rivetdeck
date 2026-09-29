# Agent Note: Electron seeds ecosystem plugins into the web profile and dedupes by ownership

Status: implemented

English | [中文](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.zh.md)

## Problem

Desktop needed preinstalled Git and Theme Studio on the Plugins page with Enable/Disable, without the Host overlay remounting them after Disable. CLI install and the Plugins page use the same profile write. A same-named package already in `$DSH_HOME` could prevent Desktop from starting.

## Decision

Required overlay names come from static `host.patch.yml` inserts, not from the Official roster. Desktop Capabilities registers the only Electron-owned Official `plugins.item` card; the Capabilities detail page lists product Components. Ecosystem plugins such as Git and Theme Studio are seeded into `$DSH_HOME/profiles/web` as pinned dependencies and, on first seed, as enabled bundles. `dsh plugin` and the Plugins page use the same profile-managed path.

Desktop Capabilities' Host half refreshes the ownership overlay on every profile composition, including HMR. Required names disable every pre-overlay copy, then the static overlay inserts one Desktop row. An enabled ecosystem package keeps the row its own `dsh.bundle.patch` inserts; extra same-name rows are disabled. A disabled ecosystem package gets no overlay insert. The overlay inserts neither Git nor Theme Studio.

The Host half supplies the current overlay through the launcher-provided `profileContext.overlays` property and restores the original property on disposal. HMR reads that property during its serialized profile reload, so a later same-name row is suppressed without changing the upstream CLI or boot packages.

Disable persists in `dsh.profile.bundles`. Uninstall drops the dependency; the next Desktop boot seeds and enables it again. Electron does not hide Uninstall. Required runtime plugins keep Desktop-owned links under `profiles/node_modules` and `profiles/web/node_modules`. Ecosystem packages are profile-owned on disk; the supervised Host overrides them only through the process-private projection in [Electron process-local ecosystem runtime ownership](2026-09-29-electron-process-local-ecosystem-runtime-ownership.md).

The Official card and the Capabilities component list are a product roster, not a dump of Loader rows. Desktop Capabilities' detail page carries a version, a Desktop badge, and plain-language component descriptions. Live component phase is recorded in [Desktop Capabilities composition root](2026-09-27-electron-desktop-capabilities-composition-root.md).

This extends [Web Plugin Manager and Git sidebar](2026-09-13-electron-plugin-manager-and-git-sidebar.md) and keeps the [npm-only ecosystem plugin](2026-09-14-electron-npm-only-ecosystem-plugins.md) distribution rule.

The [required portable UI infrastructure](2026-08-24-electron-required-portable-ui-infrastructure.md) category remains available for future non-disableable packages; Theme Studio is profile-managed instead.

## Alternatives considered

**Add `locked` or `source=desktop` to the upstream Plugin Manager.** Rejected because the Plugins page already distinguishes Official `plugins.item` cards from Installed bundles.

**Keep Git as a `host.patch.yml` insert.** Rejected because Disable cannot unmount a later overlay insert.

**Disable every pre-Electron row whose `name` matches Git.** Rejected because that would disable the bundle's own canonical `dsh-plugin-git` row.

**Hide Uninstall for seeded ecosystem plugins.** Rejected because it would add a second management system; re-seed on the next Desktop boot is the accepted recovery.

**Write Desktop-only runtime rows into the shared web profile.** Rejected because those rows are not portable; CLI `dsh web` in the same `$DSH_HOME` must not load Electron adapters.

## Consequences

Git and Theme Studio remain visible to CLI `dsh web` that shares `$DSH_HOME`, and CLI loads the profile-installed copy. Uninstall is temporary until the next Desktop start. Required-plugin session-time `pnpm` rebuilds of shared `node_modules` are not repaired until the next boot. Duplicate-id disable-then-insert for required plugins can leave a disabled predecessor beside the overlay row; one active canonical copy remains. Ecosystem runtime ownership for the Desktop Host is process-local; see [Electron process-local ecosystem runtime ownership](2026-09-29-electron-process-local-ecosystem-runtime-ownership.md).
