# Agent Note: Electron Desktop restores DeepSeek Harness brand slots locally

Status: implemented

English | [中文](2026-08-23-electron-desktop-ui-brand.zh.md)

## Problem

Upstream Web shells treat product branding as a deployment concern. Without occupants, `sidebar.brand.mark`, `sidebar.brand.name`, and `conversation.hero.brand.mark` fall back to a fish mark plus a `DSH Local Build` label and commit badge; `@deepseek-ai/dsh-client-ui-brand-official` fills those holes only when the client artifacts were built with `DSH_CLIENT_BUILD_PROFILE=official`. DeepSeek Harness Desktop must show DeepSeek Harness branding for ordinary local and release builds without editing synchronized `packages/` sources or requiring every Desktop developer to run the official client build profile.

## Decision

The brand feature at `apps/electron/runtime/plugins/desktop-capabilities/src/client/features/brand/` always injects the three brand slots with the same `FishLogo` / `BrandWordmark` artwork used by the official package, without reading `DSH_CLIENT_BUILD_PROFILE`. It is an internal Cordis feature of `@dsh-electron/dsh-electron-desktop-capabilities`, not a separate Loader package; see [Desktop Capabilities composition root](../architecture/2026-09-27-electron-desktop-capabilities-composition-root.md). Document title text remains the separate Electron Vite `DSH_CLIENT_TITLE` default (`DeepSeek Harness`).

## Alternatives considered

**Require `pnpm run build:official` for Desktop.** Rejected because Desktop packaging and day-to-day `pnpm build` would still show `DSH Local Build` unless every workflow switched profiles, and branding would stay coupled to Host client artifact env rather than the Desktop composition overlay.

**Patch upstream `ui-sidebar` fallbacks or force-register inside `packages/client/ui-brand-official`.** Rejected because the fork rule keeps product Desktop overrides in `apps/electron/**`.

**Set `DSH_CLIENT_BUILD_PROFILE` only in Electron Vite `define`.** Rejected because brand-official lives in Host-served dynamic `lib/client.js` bundles whose build-time env is already inlined; the Electron static shell define does not rewrite those plugins.

## Consequences

Desktop branding no longer depends on the upstream official client profile. When an official Host build also mounts `ui-brand-official`, both occupants may occupy the same single slots; Desktop still owns the composition that mounts the brand feature. Focused Electron tests cover slot registration teardown and the absence of `DSH_CLIENT_BUILD_PROFILE` gating.
