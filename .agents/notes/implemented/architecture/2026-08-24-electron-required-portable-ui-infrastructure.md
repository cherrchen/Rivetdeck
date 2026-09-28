# Agent Note: Electron-required portable UI infrastructure

Status: implemented

English | [中文](2026-08-24-electron-required-portable-ui-infrastructure.zh.md)

## Problem

Desktop needs built-in Client UI that is portable — no Electron, no `ctx.desktop`, no preload imports — yet must never be user-disableable through Plugin Manager, and whose canonical source is not the Electron monorepo. Upstream DSH packages place such features under `packages/` and public plugin repositories; Desktop must install them into its runtime plugin inventory without turning them into ecosystem plugins.

## Decision

`dshElectron.runtimePlugins` may hold Electron-required portable DSH UI infrastructure: a `platform: web` public package whose canonical repository is separate and whose source never enters this repository. Desktop installs the published npm artifact as an exact production dependency, validates it, and links its Host and Client artifacts without rebuilding them.

The package uses only upstream DSH client services, composes as a required `host.patch.yml` row rather than a user-manageable plugin, and never joins `dshElectron.ecosystemPlugins`. Loading the package MUST NOT occupy product UI until a consumer calls the published service.

The current `dshElectron.runtimePlugins` list is empty. Theme Studio is a user-manageable ecosystem bundle ([profile ownership note](2026-09-27-electron-profile-managed-ecosystem-and-ownership-overlay.md)); Details Host was deleted when upstream removed the Client `details` slot ([removal note](2026-09-13-electron-remove-details-host.md)).

Desktop installs this category's published artifacts instead of building them, and still forbids Electron, `ctx.desktop`, and preload imports. User-disableable product features remain independently published npm dependencies under the [npm-only ecosystem plugin rule](2026-09-14-electron-npm-only-ecosystem-plugins.md).

## Alternatives considered

**Ship it as a manageable ecosystem plugin.** Rejected because users could disable required UI infrastructure through Plugin Manager.

**Keep the subtree mirror as the Electron load source.** Rejected because one artifact would then have two authorities: the mirror can drift from the published npm build, and a source checkout can pass while the packaged application loads a different bundle.

**Bundle a Desktop-specific variant instead of the portable package.** Rejected because the portable build must stay byte-identical to what standalone `dsh` users install.

## Consequences

Desktop's required-UI inventory distinguishes mounted members from absent plugins only by `host.patch.yml` rows; adding a member without a mount silently ships dead code.

Installing a future member requires registry access for its exact production dependency; updating it requires an explicit dependency-pin and lockfile change.
