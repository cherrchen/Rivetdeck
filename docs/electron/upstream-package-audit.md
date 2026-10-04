# Electron Upstream Package Audit

English | [中文](upstream-package-audit.zh.md)

## Summary

This audit records the 2026-10-04 review of `feat/optional-managed-toolchains` against upstream tag `dsh-v0.2.0-rc.2`, including historical sync regressions and the resulting ownership decisions. The tag is an ancestor of the reviewed branch; current upstream master is outside this comparison. This is an audit record, not a claim of complete historical UI parity.

## Table of Contents

- [Current package differences](#current-package-differences)
- [Historical sync findings](#historical-sync-findings)
- [Acceptance evidence](#acceptance-evidence)
- [Maintenance](#maintenance)

<a id="current-package-differences"></a>

## Current package differences

The reviewed branch initially differed in 20 `packages/` files, with 120 added and 51 removed lines. After this work, only seven files in `packages/client/ui-plugin-manager/` differ from the pinned tag: the component, store, their two tests, and the README bilingual triplet.

| Function | Result | Requirement for shared package changes |
| --- | --- | --- |
| Effective bundle metadata | Shared plugin-manager implementation and tests match the tag; Desktop uses its existing `DesktopPluginManager` inventory | None for Electron: its inventory reads the package directory selected by `DesktopRuntime` |
| Removal permission | Downstream UI contribution retained: Uninstall follows `removable`; Enable/Disable remains independent | Current additive action slots cannot suppress the built-in Uninstall action; a shared patch or a replacement UI is required |
| Configuration lock deadline | Shared ConfigEditor matches the tag; the Electron Host replaces the same Loader row with `DesktopConfigEditor` | None: a builtin service provider and Host overlay supply the Desktop policy |

Setting `installed = false` is not an equivalent removal-permission implementation: it also removes packages from the Installed group. The retained contribution preserves their inventory visibility and enablement controls while honoring the Host's removal permission. Its maintenance policy is owned by [plugin composition](plugin-lifecycle.md#downstream-ui-contribution).

The Desktop provider inherits upstream configuration reads and owns its write transaction because the upstream edit transaction does not expose its lock deadline. It keeps validation, YAML preservation, acquisition-time re-reading, HMR serialization, overlay refusal, and reconciliation rollback. It acquires the writer lock once; it does not retry an entire edit after a timeout. The default acquisition wait is 120000 ms; zero requests an immediate acquisition attempt. This policy applies to configuration edits only: `DesktopRuntime` reconciliation still uses the atomic-write default deadline.

<a id="historical-sync-findings"></a>

## Historical sync findings

| Historical change | Sync outcome | Current disposition |
| --- | --- | --- |
| Public ecosystem plugin path and Typert service exclusions, downstream #53 | The subtree-era declarations and exclusions disappeared in the 0.1.5-rc.2 integration | Git and Theme Studio are independent npm artifacts; the old excluded service and generic Details Host are absent |
| Installation artifact preflight, downstream #65 | The shared `inspectBundlePackage` preflight disappeared | Desktop validates its bundled artifacts before linking; this is narrower than the former preflight of every user-installed bundle |
| Git Details header alignment, downstream #83 | The upstream Details-slot/layout replacement removed the old header-height publication and consumer | Git uses right-sidebar panes; the old generic Details Host and exact old alignment behavior are not restored |
| Upstream integration and Git sidebar restoration, downstream #92 | Old Details consumers stopped loading during integration; Git was adapted to the right sidebar | This was a real temporary regression followed by a plugin migration; deletion of the subtree is not evidence that Git is currently missing |
| Prefetched module transport guard | Upstream reorganized module loading | The old textual guard's disappearance alone does not establish a regression; the shared loader owns loading |
| Runtime inventory and removal UI, downstream #106 | Both contributions survived the later 0.2.0-rc.2 merge | Inventory is now Desktop-owned; removal UI remains a documented downstream contribution |

The sync workflow stops on unresolved `packages/` conflicts. It does not establish semantic compatibility for changes that Git merges without conflicts. Future sync acceptance must check feature behavior and active extension points, not only whether old source lines remain.

<a id="acceptance-evidence"></a>

## Acceptance evidence

The owner tests load the installed published Git `0.2.4` Host artifact and execute discovery, status, stage, unstage, working/index diffs, commit, history, and branch operations in a private repository. The actual Client factory loads with the current primitive dependencies and declares the right-sidebar services without requiring Desktop or the removed Details service. This verifies artifact loading and the portable dependency declarations; it does not render the three panes or establish visual parity.

The published Theme Studio `0.1.3` Client factory executes preview, cancel, apply, and restore-default behavior against its documented theme and settings interfaces. Preview does not write settings; applying and restoring do. These tests do not verify cross-process persistence after an Electron restart.

Ownership tests place a different Git version in the shared profile and verify that Desktop still reports its bundled version, source, and removal permission. Runtime artifact tests reject missing bundled outputs before links are written. Desktop configuration tests cover contention beyond the shared two-second deadline, acquisition-time re-reading, timeout without writing, inherited-value reset, validation refusal, rollback, and deadline schema validation. Shared settings/plugin-manager tests and the retained UI tests cover the unchanged upstream services and removal/enablement behavior.

No full Electron GUI, Windows installer, real-provider session, or remote Git operation was exercised in this audit. The old generic Details Host, old alignment behavior, and full user-installation preflight remain explicit historical differences rather than accepted equivalence claims.

<a id="maintenance"></a>

## Maintenance

The architecture test compares `apps/cli` and `packages/boot` with the pinned tag, so committed drift is checked as well as working-tree drift. CI and release test jobs fetch that upstream tag explicitly because downstream origin does not publish it. When changing the upstream pin, review this comparison and the Desktop transaction against the new upstream implementation. Keep package-manager dependency synchronization aware of the Desktop ConfigEditor dependency. Use the [composition reference](plugin-lifecycle.md) for the current configuration and the retained UI contribution policy.
