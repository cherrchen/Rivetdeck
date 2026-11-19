# Temporary Upstream Sync Patches

English | [中文](upstream-sync-patches.zh.md)

## Summary

Rivetdeck temporarily patches two upstream hygiene checks against the pinned `dsh-v0.2.2-rc.5` release. Review each patch at every upstream synchronization and remove it in the first sync whose incoming upstream implementation passes the checks below. These are temporary maintenance fixes, not permanent downstream behavior.

The previous synchronization retired the vendor-rescoping patch: the incoming checker rescopes only module imports and keeps the documented preset identifiers, so the local exceptions and the two documentation bullets that described them were removed. Upstream fixed three files that the tag still missed after it shipped; this repository carries that fix ahead of the pin as the patch below.

## Table of Contents

- [Temporary patches](#temporary-patches)
- [Retirement during synchronization](#retirement-during-synchronization)
- [Dev Note](#dev-note)

<a id="temporary-patches"></a>

## Temporary patches

The two issues belong to upstream checking code; packaged Desktop artifacts expose the second issue locally.

| Patch | Local changes | Required upstream behavior before retirement |
| --- | --- | --- |
| Preserve Creator preset identifiers the tag's rescope mapping missed | [Rescope checker](../../scripts/rescope-vendor.ts) and [tests](../../scripts/rescope-vendor.spec.ts): `GENERIC_SKIPS` entries for `apps/web/tests/creator-persona.e2e.ts` and the two `subagent-interrupt-default` upgrade-guide files, ported from the upstream fix that shipped after the tag | The checker covers every file whose `cordis` spelling is a preset identifier while still rescoping framework imports, and `pnpm run rescope-vendor:check` passes on the pristine upstream tree. |
| Exclude packaged applications from source configuration discovery | [Configuration discovery](../../scripts/cordis-config-files.ts) and [tests](../../scripts/cordis-config-files.spec.ts): exclude root `dist/` and cover a packaged configuration | Packaged configuration copies under root `dist/` are excluded, while source Loader configurations remain checked. Old packaged copies must not cause source-resolution failures. |

<a id="retirement-during-synchronization"></a>

## Retirement during synchronization

For each patch, inspect the incoming upstream implementation and test it without the corresponding local additions. A version change or conflict-free merge alone does not establish that the issue is fixed. If the upstream implementation passes that row's checks, remove the local implementation, redundant test adaptations, and duplicate documentation in the same synchronization. Keep upstream coverage and any remaining downstream regression coverage. If only one issue is fixed, retire only that patch; retain the other until its own checks pass.

Remove changes by patch, not by restoring entire files. Shared files also contain other downstream changes, including Windows Git-symlink handling in configuration reads and existing rescope corrections. Preserve those changes unless their own retirement conditions are met.

Run the affected checker tests and the complete hygiene aggregate after retirement. On the 8 GiB development host, the default Node heap is insufficient for the optional-dependency import check; the verified aggregate invocation is:

```sh
NODE_OPTIONS=--max-old-space-size=4096 DSH_GATE_CONCURRENCY=3 pnpm run hygiene
```

These resource settings are local validation parameters, not a third source patch. Remove each retired row from this reference. When both rows are retired, remove this bilingual reference and its link in [the downstream instructions](../../AGENTS.downstream.md#upstream-synchronization).

<a id="dev-note"></a>

## Dev Note

None.
