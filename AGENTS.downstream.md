# AGENTS.downstream.md

This repository is the **Rivetdeck** downstream fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). It packages the upstream agent harness as a native Electron desktop application for macOS, Windows, and Linux. Upstream owns the core runtime, packages, and documentation spine; this fork owns the desktop shell, downstream CI/CD, release channels, and repository landing pages.

## Repository relationship

| Area | Owner | Notes |
|------|-------|-------|
| `packages/**` | Upstream | Merged from `upstream/master` on `develop`; retain the scoped [UI contribution](docs/electron/plugin-lifecycle.md#downstream-ui-contribution) |
| `vendor/`, `apps/cli`, `apps/web` | Upstream | Merged from `upstream/master` on `develop` |
| `docs/**` (except `docs/electron/**`) | Upstream | Core harness documentation spine |
| `docs/electron/` | Downstream | Desktop architecture and other downstream-owned docs — [architecture](docs/electron/architecture.md) |
| `apps/electron/` | Downstream | Desktop shell, updater, installers |
| `README.md`, `README.zh.md`, `README.i18n.yaml` | Downstream | Never overwritten by upstream sync |
| `AGENTS.md` | Upstream | Sync accepts upstream; restore `@AGENTS.downstream.md` after each sync |
| `AGENTS.downstream.md` | Downstream | This file — fork-specific rules only |
| `.github/workflows/sync-upstream.yml`, `desktop-*.yml` | Downstream | Not present upstream |

The `upstream` remote points at `https://github.com/deepseek-ai/deepseek-harness.git`. Routine upstream integration happens only on `develop`; `main` receives promoted code through a reviewed Pull Request.

## Git branch model

```
feature branch  →  develop  →  main
```

### `main`

`main` is the stable branch and the only branch used for RC and Stable desktop releases.

- GitHub Protected Branch — no direct push
- No routine development commits
- No upstream sync merges
- Accepts Pull Requests **only** from `develop`
- `develop → main` must use **Squash Merge**
- Publishes `v*-rc.*` (Pre-Release) and `va.b.c` (Release) tags

### `develop`

`develop` is the primary development branch and the upstream sync target.

- Receives upstream merges from [`sync-upstream.yml`](.github/workflows/sync-upstream.yml)
- Receives feature Pull Requests from `codex/*`, `dev/*`, `cursor/*`, and `agent/*`
- Integrates Electron downstream changes
- Runs routine desktop CI
- Publishes `v*-beta.*` (Pre-Release) tags after each successful upstream sync

### Feature branches

Prefixes `codex/*`, `dev/*`, `cursor/*`, and `agent/*` are development branches for features, bug fixes, CI/CD changes, Electron work, and documentation. Open Pull Requests against **`develop`**, never directly against `main`.

## Upstream synchronization

[`sync-upstream.yml`](.github/workflows/sync-upstream.yml) is pinned to **`dsh-v0.2.0-rc.2`**: the six-hour master schedule is disabled, and `workflow_dispatch` must set `allow_master_sync` before it may merge `upstream/master`. The target branch is **`develop`** — never `main`. Re-enable the schedule only after an explicit decision to leave that pin.

```
upstream/master  →  develop  →  v{a.b.c}-beta.{x}
```

After a verified merge the workflow:

1. Synchronizes Electron workspace dependencies from the upstream graph
2. Regenerates `pnpm-lock.yaml`
3. Runs focused Electron tests and builds
4. Pushes to `develop`
5. Dispatches [`desktop-ci.yml`](.github/workflows/desktop-ci.yml)
6. Creates the next `v{a.b.c}-beta.{x}` tag and triggers a Beta desktop release

### Conflict resolution

| File(s) | Strategy |
|---------|----------|
| `README.md`, `README.zh.md`, `README.i18n.yaml` | **Downstream wins** — `.gitattributes` `merge=ours` |
| `docs/electron/**` | **Downstream wins** — `.gitattributes` `merge=ours` |
| `AGENTS.md` | **Upstream wins** — accept upstream, then run `restore-agents-downstream.mjs` |
| Upstream workflows and `scripts/ci-workflow.spec.ts` | **Upstream wins** — `.gitattributes` uses `merge=theirs`; the sync job registers that driver before merging |
| `.github/workflows/desktop-*.yml`, `.github/workflows/sync-upstream.yml`, `scripts/desktop-workflow.spec.ts` | **Downstream wins** — `.gitattributes` uses `merge=ours` |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml` | Accept upstream, confirm `apps/electron` remains in the workspace, run `pnpm install --no-frozen-lockfile`, commit the regenerated lockfile |
| Other `*.i18n.yaml` | Register the `dsh-translation-pairing` merge driver before merge; if a pairing record still conflicts, run `pnpm run resolve-translation-pairing-conflicts` to regenerate it from the merged owners. Abort when an owner Markdown file also conflicts or the resolver rejects the record. |
| All other conflicts | Abort — manual resolution required |

The lockfile goal is: upstream dependency state plus downstream `apps/electron` dependency state equals the final lockfile. Do not preserve a stale downstream lockfile to avoid upstream dependency updates.

### `AGENTS.md` restoration

After each upstream merge that touches `AGENTS.md`:

1. Accept the upstream file body
2. Do not maintain long-lived edits to upstream `AGENTS.md` prose
3. Ensure the file ends with `@AGENTS.downstream.md`

Run `node apps/electron/scripts/restore-agents-downstream.mjs` when the marker is missing. `verify-doc-budgets` skips root `AGENTS.md` so an upstream word-count ceiling cannot force downstream edits; fork rules stay in this file.

## Downstream file protection

Never let upstream sync overwrite:

- `README.md`, `README.zh.md`, `README.i18n.yaml`
- `docs/electron/**`
- `AGENTS.downstream.md`
- `apps/electron/**` (except shared lockfile regeneration side effects)

Treat `.github/workflows/desktop-*.yml`, `.github/workflows/sync-upstream.yml`, and `scripts/desktop-workflow.spec.ts` as downstream-owned. All other `.github/workflows/*.yml` files and `scripts/ci-workflow.spec.ts` are upstream-owned.

Downstream changes may create new Agent Note triplets or update Agent Note triplets originally created by this downstream repository. Never modify an Agent Note Markdown owner or `*.i18n.yaml` sidecar created by upstream; record downstream-specific decisions in a new downstream-owned Agent Note and link to the upstream note from the downstream note when necessary.

## Desktop architecture constraints

Full CURRENT vs TARGET specification, ownership tables, milestones, anti-patterns, and ADRs: [docs/electron/architecture.md](docs/electron/architecture.md) ([中文](docs/electron/architecture.zh.md)). Concise developer entry: [apps/electron/README.md](apps/electron/README.md).

Before architecture-sensitive Desktop work, read that guide, then classify the change as Electron Core, Desktop Capability, Feature Plugin, upstream Harness change, or build/release.

Standing rules (do not duplicate the full architecture doc here):

- Desktop-only changes stay under `apps/electron/**` and `docs/electron/**`. Public ecosystem plugins are independently published npm packages; do not mirror their source into this repository. Do not modify `apps/web`, upstream `docs/**` (outside `docs/electron/**`), or `packages/**` for Desktop-only UI unless the change is intentionally upstream-compatible and meant for upstream contribution. The existing `packages/client/ui-plugin-manager/` removal-permission contribution remains a maintained downstream exception until equivalent upstream behavior is verified; follow its [maintenance policy](docs/electron/plugin-lifecycle.md#downstream-ui-contribution).
- Electron remains the stable desktop platform; DSH/Cordis plugins are the extensible product feature layer. Do not make the Electron app itself a Cordis plugin, and do not rebuild a second product frontend in `apps/electron/src/renderer`.
- Keep Renderer bootstrap thin (`bootstrap.ts` / `renderer/main.ts`). Portable and Desktop-aware product features belong in independently published DSH packages; `apps/electron/runtime/plugins/` holds Desktop adapters, Electron carrier plugins, and Desktop-only integration; Electron-required portable DSH UI infrastructure ships as a published npm package declared in `dshElectron.runtimePlugins`. Host composition stays explicit in `runtime/host.patch.yml`.
- Feature plugins MUST NOT import Electron, `ipcRenderer`, or Node. Native OS operations cross the Desktop Capability Provider (`ctx.desktop`); only renderer infrastructure and the provider may read `window.deepseekDesktop` directly. Do not add a generic IPC escape hatch.
- `@dsh-electron/dsh-plugin-*` packages are Native-compatible by default and MUST NOT depend on an Electron provider. Optional native enhancement runs in a child `ctx.inject(['desktop'], ...)` fiber so the portable core remains active when `desktop` is absent or unloads. Reserve `@dsh-electron/dsh-electron-*` for Desktop-required infrastructure. Electron-required portable DSH UI infrastructure is a published package that holds the same runtime status as a `runtime/plugins/` member, is declared in `dshElectron.runtimePlugins`, composes as a required `host.patch.yml` row rather than a user-manageable plugin, and MUST NOT join `dshElectron.ecosystemPlugins`, which is reserved for external public DSH plugins.
- Prefer existing upstream Cordis/DSH seams before inventing Desktop-specific APIs; only the privileged portion should enter Electron Main.
- Retain the supervised loopback `dsh web` Host transport unless measured evidence justifies replacement ([architecture §24](docs/electron/architecture.md#24-optional-milestone-4--transport-optimization)).
- Update CURRENT architecture prose only after behavior ships; update TARGET prose only after an explicit architecture decision.

## Electron development constraints

- Downstream-owned npm packages under `apps/electron/` publish under the `@dsh-electron/` scope (for example `@dsh-electron/dsh-electron`, `@dsh-electron/dsh-electron-desktop-capabilities`). Upstream-synced packages under `packages/`, `vendor/`, and `apps/cli` / `apps/web` keep the `@deepseek-ai/` scope.
- All desktop release work targets `apps/electron/`
- Build the upstream runtime before starting Electron locally (`pnpm run build` then `pnpm --filter @dsh-electron/dsh-electron start`)
- Desktop-owned registry dependencies (including exact bundled plugin pins declared in `dshElectron.runtimePlugins` and `dshElectron.ecosystemPlugins`) and declared desktop entry dependencies are retained across upstream dependency sync; other workspace dependencies are regenerated from the upstream CLI graph. A leftover `workspace:` specifier whose package is absent after the merge is dropped; it is not retained as a registry dependency ([rationale](.agents/notes/implemented/bug-fix/2026-08-20-drop-stale-electron-workspace-specifiers.md))
- Packaged builds use `electron-builder` with NSIS (direct Windows), Store-only AppX (Microsoft Store), DMG/ZIP (macOS), and AppImage/DEB (Linux) on native x64 and ARM64 runners; Store identity and package version belong to `apps/electron/windows-store.json`
- Release artifacts are unsigned unless platform signing credentials are configured
- Direct-distribution updates read GitHub Release metadata; tag names follow `v{a.b.c}[-beta.x|-rc.x]` — not the legacy `electron-dsh-v*` format. Microsoft Store owns Store-build updates; never enable GitHub installation in those artifacts

## Release and version rules

### Tag formats

| Channel | Branch | Tag example | GitHub Release type |
|---------|--------|-------------|---------------------|
| Beta | `develop` | `v0.1.0-beta.1` | Pre-Release |
| RC | `main` | `v0.1.0-rc.3` | Pre-Release |
| Stable | `main` | `v0.1.0` | Release |

No other tag formats are permitted.

### Beta auto-increment

After each upstream sync to `develop`, the sync workflow creates the next `v{a.b.c}-beta.{x}` tag. The `beta.x` suffix increments independently within the same `a.b.c` range and does not track upstream pre-release numbers. Example: upstream at `0.1.0-rc.3` yields downstream betas `v0.1.0-beta.1`, `v0.1.0-beta.2`, …

### RC and Stable alignment

RC and Stable versions must match upstream exactly, including the `rc.x` suffix:

- Upstream `0.1.0-rc.3` → downstream RC tag `v0.1.0-rc.3`
- Upstream `0.1.0` → downstream Stable tag `v0.1.0`

[`desktop-promote.yml`](.github/workflows/desktop-promote.yml) creates RC/Stable tags on `main` after a `develop → main` promotion. Version comparison must consider both `a.b.c` and `rc.x`, not the base version alone.

### Electron package version

`apps/electron/package.json` `version` must equal the release tag without the `v` prefix:

- Tag `v0.1.0-beta.3` → `"version": "0.1.0-beta.3"`
- Tag `v0.1.0-rc.3` → `"version": "0.1.0-rc.3"`
- Tag `v0.1.0` → `"version": "0.1.0"`

Set versions through pnpm scripts — do not hand-edit unless no script exists:

```sh
pnpm electron:set-version 0.1.0-beta.3
pnpm install --no-frozen-lockfile   # when lockfile must follow manifest changes
```

[`set-version.mjs`](apps/electron/scripts/set-version.mjs) updates the Electron manifest. [`sync-version.mjs`](apps/electron/scripts/sync-version.mjs) synchronizes workspace dependencies from the upstream CLI graph.

## CI / CD workflow responsibilities

| Workflow | Trigger | Role |
|----------|---------|------|
| [`sync-upstream.yml`](.github/workflows/sync-upstream.yml) | Schedule, dispatch | Merge upstream → `develop` when upstream changed; publish Beta tag |
|[`desktop-ci.yml`](.github/workflows/desktop-ci.yml)|Push/PR to `develop`, push to `main`|Test and compile without packaging, plus the supervised Host startup path on Windows|
| [`desktop-release.yml`](.github/workflows/desktop-release.yml) | Tag push, dispatch | Package and publish installers for all platforms |
| [`desktop-store.yml`](.github/workflows/desktop-store.yml) | Dispatch | Build and verify unsigned x64/ARM64 AppX submission artifacts; Partner Center submission is manual |
| [`desktop-promote.yml`](.github/workflows/desktop-promote.yml) | Push to `main` | Create RC/Stable tags matching upstream version |

All other workflow files are retained from upstream for clean synchronization but are not part of the downstream CI/CD policy.

## Branch operation restrictions

| Action | Allowed |
|--------|---------|
| Feature branch → `develop` PR | Yes |
| Feature branch → `main` PR | **No** |
| Direct push to `main` | **No** |
| Direct push to `develop` (humans) | Avoid — use PRs; sync bot is the exception |
| Upstream sync → `develop` | Yes (automated) |
| Upstream sync → `main` | **No** |
| `develop → main` Squash Merge PR | Yes (release promotion) |
| Beta tag on `develop` | Yes (automated after sync) |
| RC / Stable tag on `main` | Yes (via `desktop-promote.yml` or manual dispatch) |
| Beta tag on `main` | **No** |
| RC / Stable tag on `develop` | **No** |

## Commands

```sh
pnpm install
pnpm run build
pnpm --filter @dsh-electron/dsh-electron test
pnpm --filter @dsh-electron/dsh-electron build
pnpm electron:sync-version          # sync workspace deps from upstream CLI graph
pnpm electron:set-version <version> # set Electron manifest version
node apps/electron/scripts/next-beta-tag.mjs   # print next beta tag for current tree
node apps/electron/scripts/restore-agents-downstream.mjs
```

## Release promotion flow

```
Upstream
   ↓  sync-upstream.yml
develop
   ↓  v{a.b.c}-beta.{x}  →  desktop-release.yml
develop → main PR (Squash Merge)
   ↓  desktop-promote.yml
main
   ↓  v{a.b.c}-rc.{x} or v{a.b.c}  →  desktop-release.yml
RC / Stable installers
```
