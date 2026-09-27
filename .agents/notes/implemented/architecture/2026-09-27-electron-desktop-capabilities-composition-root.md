# Agent Note: Electron Desktop Capabilities is the Client composition root

Status: implemented

English | [中文](2026-09-27-electron-desktop-capabilities-composition-root.zh.md)

## Problem

Desktop Client adapters for directory picking, brand, network settings, and the Official Plugins roster each shipped as their own Loader/npm package and overlay row. The Plugins page listed every overlay insert as an Official card, so Loader inventory, Official items, and product Components were forced to stay equal. `@dsh-electron/dsh-electron-desktop-capabilities` used `immediately: true` with only `ui-renderer` inject, which would pull product UI packages into stage-one if those Client adapters merged into its `dsh.client.inject` union.

## Decision

`@dsh-electron/dsh-electron-desktop-capabilities` is the one Desktop Client Loader/npm package. Its Host half refreshes the ownership overlay for profile HMR. Its one `lib/client.js` provides `ctx.desktop` first, then mounts internal feature plugins with Cordis `ctx.plugin()`. Features live under `src/client/features/{directory-picker,brand,network-settings,plugin-manager}/`, export `name` / `inject` / `apply` with no default export, and are not npm packages, Loader rows, or npm subpath plugins.

The composition package is not `immediately: true`. `dsh.client.inject` is the union of the former Client adapters minus a self-reference; `dsh.client.external` keeps `@deepseek-ai/dsh-client-ui-primitives`. `ctx.desktop` activates with the application batch. Features that need it declare Cordis `inject: ['desktop', …]`. External Desktop-aware plugins continue `ctx.inject(['desktop'], …)`.

The Plugins page registers an Official `plugins.item` card only for Desktop Capabilities. The Capabilities detail page lists five product Components (network subprocess, directory picker backend, directory picker, brand, network settings). Each row shows a package specifier: `@dsh-electron/dsh-electron-desktop-capabilities/<feature>` for internal features, and the independent npm name for Loader-backed adapters. These specifiers are display names, not Loader rows. Rows cannot be enabled, disabled, or uninstalled. Displayed phase comes from Host `pluginInventory/list` for Loader-backed rows, and from the Client feature fiber for directory-picker, brand, and network-settings. Desktop Capabilities' detail page shows a version tag, a Desktop badge, the package name, and plain-language component descriptions.

`host.patch.yml` inserts three Loader rows: network-subprocess, directory-picker-browse, and desktop-capabilities. Required package ownership names come from those static insert package names. `@dsh-electron/dsh-electron-network-subprocess` stays an independent Host provider. Theme Studio and Git are portable ecosystem bundles. `@dsh-electron/dsh-electron` is the application package, not a plugin parent.

This extends [typed Main bridge ownership](2026-08-21-electron-desktop-capability-ownership.md), keeps [local brand occupancy](../feature/2026-08-23-electron-desktop-ui-brand.md), and splits Official cards from overlay inserts in [ecosystem seed and ownership overlay](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.md).

## Alternatives considered

**Keep four independent packages and only hide Official cards.** Rejected because Client adapters would still be Loader rows, overlay inserts, and discovery inventory; the Plugin Manager would still present a parallel product tree.

**Expose features as npm subpath Loader plugins (`…/ui-brand`).** Rejected because the Client module system binds the browser half to the bare package name; a subpath row has no `lib/client.js`.

**Nest features under the `@dsh-electron/dsh-electron` application package.** Rejected because that package is the Electron application, not a Loader plugin.

**Merge `desktop-network-subprocess` into the capabilities Host half now.** Rejected until fiber order, `LocalSubprocessRuntime` subclassing, and `DSH_ELECTRON_AGENT_PROXY_POLICY` are proven; it stays an independent Loader row.

## Consequences

`runtime/plugins/` discovery sees only desktop-capabilities and desktop-network-subprocess. Tests lock overlay insert names, Official item ids, and Capabilities Components as three lists. Features that inject `desktop` stay pending until the Service provides it, including when parent `apply` plugins them before the Service. Parent fiber dispose removes feature slots and locale dictionaries. Theme Studio still declares no `desktop` inject.
