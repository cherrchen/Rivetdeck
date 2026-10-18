# Uninstall and Data Cleanup

English | [中文](uninstall-data-cleanup.zh.md)

> Status: **implemented for Windows NSIS — native install/uninstall verification pending in CI**
>
> This document records CURRENT uninstall behavior, the upstream `apps/desktop` cleanup design, external agent-tool precedents, and the reviewed design that now ships. External review accepted three principles — protect `$DSH_HOME`, skip cleanup during updates, and delete without following links — and rejected unconditional `userData` deletion. The review conclusions below are the working contract; remaining open items are listed at the end.

## Current uninstall behavior

The downstream Windows installer is an assisted NSIS build (`oneClick: false`, `allowToChangeInstallationDirectory: true`, ZIP payload) produced by `apps/electron/scripts/prepare-windows-installer.mjs`. On Windows packaging hosts the script compiles `installer/uninstall-data.cpp` into `rivetdeck-uninstall.dll` (`scripts/prepare-windows-uninstall-helper.ps1`), projects the stock templates with the `--delete-app-data` `RMDir /r` bypass stripped, and emits `customInstall`/`customUnInstall` macros plus LangStrings generated from `installer/uninstall-messages.yml`.

Each packaged launch merges the resolved `userData` and `DSH_HOME` into a line-oriented record beside the default userData (`src/path-history.ts`, `%APPDATA%\rivetdeck-path-history.ini`) before the fallible startup steps run, so a launch that fails during network or runtime preparation still leaves its roots on record. The location stays writable by the installed app even for elevated installs, and it survives install-directory removal. Fresh installs seed the record `complete=1`; the first record after an upgrade stays incomplete because it cannot prove which roots ran before it existed.

On uninstall, `customUnInstall` calls `un.RivetdeckCleanData`, which keeps all data when the uninstaller runs for an update (`--updated`) or a same-product replacement (`/KEEP_APP_DATA`); the record beside the default `userData` is outside `$INSTDIR`, so it already survives for the succeeding install. Otherwise the flow resolves the current `userData` root (`$APPDATA\Rivetdeck`), the updater cache (`%LOCALAPPDATA%\rivetdeck-updater`), the environment `DSH_HOME`, and the record, and hands them to the native `UninstallCleanup` entry point (`installer/uninstall-cleanup.h`). The helper applies the layered policy: `managed-toolchains/`, `electron/toolchains/bin`, named cache directories including per-partition equivalents, and the updater cache are removed after ownership and expected-inventory checks; `desktop-preferences.json`, `network-secrets/`, `network-startup-override.json`, and persisted browser storage stay. `--delete-app-data` removes the whole `userData` root only while the record is present and complete. Targets that fail verification or overlap a protected path are skipped whole; skips and removal failures land in `%APPDATA%\Rivetdeck-uninstall-residue.log` and the uninstaller details page.

The macOS DMG/ZIP and Linux AppImage artifacts ship no uninstaller; the DEB removes only `/opt/Rivetdeck`. The MSIX (Store) build is removed by the operating system including virtualized per-package data, but non-virtualized pre-existing files persist, and `~/.dsh` is outside virtualization — see "Other platforms" for the verification gap.

## Write locations and ownership

Every write root needs an explicit owner and cleanup policy:

| Root | Contents | Owner and policy |
| --- | --- | --- |
| `$INSTDIR` | Program files, `resources/core-runtime` (Windows `node.exe`), `resources/network-runtime` | Installer — already removed |
| `userData/managed-toolchains` and `userData/electron/toolchains` | Downloaded Node/Python generations, receipts, staging, shims | App-private, fully rebuildable — primary cleanup target |
| Chromium cache directories in `userData` | `Cache/`, `Code Cache/`, `GPUCache/`, and their per-partition equivalents | App-private, rebuildable — cleanup target |
| `userData` (remainder) | `desktop-preferences.json` (proxy config, update channel, runtime onboarding), `network-secrets/` (usable encrypted proxy credentials), `network-startup-override.json`, `electron-host.patch.yml`, persisted browser storage (cookies, Local Storage, IndexedDB, and other session-partition data) | App-private settings, credentials, and user content — preserved by default under the reviewed design |
| Updater cache | Downloaded update packages | App-private, rebuildable — cleanup target |
| `$DSH_HOME/electron` | `python-user/` and `node-global/` user-installed packages, `bin/` shims, `host-profile/`, markers | App-private subtree inside a shared home — the uninstaller must not remove it; contents include user-installed packages, not cache |
| `$DSH_HOME` (remainder) | Sessions, storages, settings, `.credentials.yaml`, web profile, plugins, caches | Shared Harness home — `dsh` CLI and other consumers share it; never remove automatically |
| `~/.agents` | User-level skills shared across agent tools | Shared — never remove automatically |
| Workspace directories | User projects | User — never remove |

`userData` is relocatable via `--user-data-dir`, and `$DSH_HOME` via the `DSH_HOME` environment variable. The uninstaller cannot discover these overrides from its own environment alone; see "Path discovery and protection".

## Upstream `apps/desktop` design

The upstream desktop app implements the cleanup model the downstream lacks. Sources: `apps/desktop/installer/uninstall.nsh`, `apps/desktop/installer/uninstall-data.h`, `apps/desktop/scripts/installer.nsh`, `apps/desktop/scripts/windows-directory-installer.mjs`.

### Ownership split

Upstream removes all Electron-owned data on a real uninstall and never touches the Harness home. Electron-owned means the install directory (including its bundled primary runtime), Electron `userData` (which also holds logs and crash reports via `app.setAppLogsPath()`), and the updater cache. Harness-owned means everything under `DSH_HOME`, including the app-specific `profiles/desktop` profile and lock (`apps/desktop/src/paths.ts`) — even those stay.

### Structural difference: bundled versus managed runtimes

Upstream's Node, pnpm, and Python ship inside the installer payload (`scripts/prepare-primary-runtime.ts` builds a `primary-runtime` tree with an integrity manifest verified by `src/runtime-tree.ts`). They live under `$INSTDIR` and are removed together with the program. The downstream instead downloads managed Node/Python into `userData/managed-toolchains` after install (`runtime-environments.md`), so its runtime residue problem does not exist upstream: the downstream must delete `userData` subtrees to reclaim those runtimes.

### Uninstaller flow

`customUnInstall` calls `un.CleanData`, which:

1. Does nothing under `${isUpdated}` — an update must never delete data.
2. Honors `/KEEP_APP_DATA`, used when an older uninstaller is replaced from a different install directory.
3. Reads `DSH_HOME` from the environment to protect it, not to delete it.
4. Removes `$APPDATA\${PRODUCT_FILENAME}`, `$APPDATA\${APP_PACKAGE_NAME}` when present, and `$LOCALAPPDATA\${DSH_UPDATER_CACHE_NAME}` (which also contains installer logs kept there so they outlive `$PLUGINSDIR`).
5. Prunes emptied parent directories up to a fixed stop directory.

`windows-directory-installer.mjs` adapts the stock templates: it strips the electron-builder app-data deletion block entirely so that data removal happens only through the native helper, never through `RMDir /r` on a data root.

### Deletion safety (`uninstall-data.h`)

Because `$DSH_HOME/profiles/*/node_modules` and toolchain trees contain junctions and symlinks, a naive recursive delete can escape into linked targets. The native helper therefore:

- normalizes and rejects malformed paths, filesystem roots, and protected known folders;
- rejects targets containing or contained by `$INSTDIR` or the configured Harness home;
- pins parent directories with open handles and refuses reparse-point roots;
- removes directory trees without following links into external targets;
- attempts every sibling and reports the first error, tolerating locked-file residue so a still-running Host cannot fail the uninstall.

### Limits of the upstream path-discovery model

Upstream reads `DSH_HOME` only from the uninstall process's own environment. That protects the default and the permanently-set cases, but cannot recover a `DSH_HOME` set transiently for one launch or a historical `--user-data-dir`. If the app ever ran with `DSH_HOME` pointed inside `userData`, an uninstaller that trusts only its current environment could delete a directory holding sessions. The reviewed design below therefore requires a persisted path record rather than environment-only discovery.

## External precedents

The dominant pattern across agent CLIs and editors: remove the binary/program, retain user state by default, and offer data deletion as an explicit opt-in, keep-flag inverse, or documented manual step. Sources are official documentation and issue trackers at the versions current when this document was written.

| Tool | Removal mechanism | User data on uninstall |
| --- | --- | --- |
| electron-builder NSIS | stock uninstaller | deleted only with `--delete-app-data` or `DELETE_APP_DATA_ON_UNINSTALL` |
| VS Code | Inno Setup uninstaller | `%APPDATA%\Code` and `~/.vscode` kept by design (microsoft/vscode#66837, closed as intentional); docs publish a "clean uninstall" path list |
| Cursor | uninstaller | `%APPDATA%\Cursor`, `~/.cursor`, `%LOCALAPPDATA%\cursor-updater` kept; support confirms the VS Code policy |
| Chrome | uninstaller | "Also delete your browsing data" checkbox, unchecked by default |
| Squirrel.Windows | Update.exe | `%LocalAppData%\<app>` never removed (the leftover also marks "user uninstalled" for machine-wide installs); app-side `rimraf` in the `--squirrel-uninstall` event fails on locked files |
| Claude Code | per-method removal (native `rm`, `npm uninstall -g`, brew, winget) | `~/.claude` and `~/.claude.json` always retained — shared with the desktop app and IDE extensions; docs publish manual cleanup commands |
| Codex CLI | no uninstaller | `$CODEX_HOME` (`~/.codex`) never touched; community recipes remove only the binary and standalone package cache |
| Devin CLI | `devin uninstall` | interactive by default; `--clean` removes all data (config, history, custom data), `--force` skips confirmation |
| Pi | installer rerun → "Uninstall Pi", or npm/Nix removal | documented: config, credentials, sessions under `~/.pi/agent/` are never removed |
| omp | none (open feature request) | community proposal: binary-only by default, `--purge` for `~/.omp`, refuse to remove worktrees with uncommitted work |
| opencode | `opencode uninstall` (v2 CLI docs) | removes the binary and all related files by default; `--keep-config` and `--keep-data` preserve configuration and session data; `--dry-run` previews |

Two observations survive review. First, retention-by-default remains the dominant policy for settings, credentials, and session content; the counterexample (opencode) deletes by default but distinguishes keepable classes through `--keep-config`/`--keep-data` rather than treating all state as one unit — the same class split this design needs. Second, large rebuildable artifacts are the accepted deletion candidates: opencode removes its global cache, and upstream removes `userData`; the downstream's `managed-toolchains` and updater cache belong to that class, while `desktop-preferences.json` and `network-secrets/` do not.

## Candidate designs

Four designs cover the decision space for the Windows NSIS uninstaller; all share "never touch `$DSH_HOME`, `~/.agents`, or workspace files".

- **D — tiered cleanup (review recommendation).** Uninstall removes only explicitly rebuildable targets — `managed-toolchains/`, `electron/toolchains/bin`, named pure-cache directories (`Cache/`, `Code Cache/`, `GPUCache/`, and their per-partition equivalents), and the updater cache — while preserving `desktop-preferences.json`, `network-secrets/`, `network-startup-override.json`, and all persisted browser storage. Session partitions are not cache: they can hold cookies, Local Storage, and IndexedDB carrying real user state such as unsent drafts, so they are deleted only under `--delete-app-data`, which escalates to full `userData` removal. This reclaims the large residue without sacrificing a working proxy configuration, which a user behind a manual proxy may need before they can re-download runtimes.
- **A — full `userData` removal by default (upstream-aligned).** Removes everything Electron-owned except `$DSH_HOME`. Retained as an explicit product choice, not a free win: it discards proxy configuration, update channel, runtime onboarding state, and still-usable encrypted credentials, and can leave a proxied user unable to re-download runtimes after reinstall.
- **B — Chrome-style opt-in.** The assisted uninstaller shows an "also remove application data" choice (default: keep); `/S` keeps data; `--delete-app-data` forces full removal in silent mode. Preserves reinstall-keeps-settings, but adds a custom uninstaller page plus its localization, and leaves the toolchain residue for most users.
- **C — flag-only.** Keep the stock `--delete-app-data` semantics, extend them to the updater cache, document the flag. Minimal change, but effectively undiscoverable — today's residue stays the norm.

A separate in-app or documented "reset application data" path remains possible but is scoped independently (see review conclusions).

## Path discovery and protection

"Never delete `$DSH_HOME`" is only enforceable if the uninstaller knows which directories the app actually used. The uninstall process's own environment is insufficient: a launch script can set `DSH_HOME` transiently, and `--user-data-dir` relocates the root that holds managed runtimes. The design must therefore define, before implementation:

1. **A persisted history set of effective roots.** Each launch merges the resolved `userData` and `DSH_HOME` paths into a durable record rather than overwriting the previous entry: a Harness home used for an earlier launch and later switched away stays protected. The record lives in a per-user, per-install-instance location the uninstaller can read without the app's launch environment — for example a value under the product's HKCU uninstall registry key, or a file beside the uninstaller when `$INSTDIR` is per-user-writable. It must not depend on writing an all-users `$INSTDIR` or HKLM, which a normally-privileged app cannot update. The record also tracks its own coverage: one first created after an upgrade cannot attest which roots ran before it existed, so it carries an incomplete-history state that keeps the conservative skipping below instead of pretending the history is whole.
2. **Separate roles for recorded paths.** Historical `DSH_HOME` entries always join the protection set. Historical `userData` entries locate and verify cleanup candidates; they are never protection by themselves — their settings and persisted storage survive through the same tiered policy that preserves them in the current root.
3. **Deletion candidates verify attribution.** A deletion target must be attributable to this product and match its expected inventory — for example `desktop-preferences.json` or `managed-toolchains/{node,python}/active.json` — never trusted from the path string alone.
4. **Protected paths need no attribution.** A recorded `DSH_HOME` joins the protection set unconditionally; a shared Harness home may contain no Electron markers at all. A malformed or unresolvable record does not drop a protection claim — it blocks every deletion whose safety cannot be proven without that record.
5. **Safety is proven, not assumed.** "No overlap found" is not "no overlap exists": a missing or incomplete history record means a past `DSH_HOME` inside `userData` cannot be ruled out, so absence of evidence does not authorize deletion. Each deletion target must prove its isolation — full `userData` removal under `--delete-app-data` requires a complete history record attesting that no protected path ever lived inside; a tiered target must match its expected inventory, and foreign content beyond the expected shape skips the whole target rather than being emptied with it. Any target that overlaps a protected path — recorded or environment-derived — is likewise skipped entirely, with the skip reported in the residue. Installs that predate the record — or whose record reports incomplete history — use environment plus defaults for protection and apply this same proof requirement, which limits them to targets that verify cleanly.

## Safety requirements

1. Never delete data during an update (`isUpdated`) or during a same-product uninstaller replacement (`/KEEP_APP_DATA` equivalent); these protections take precedence over any deletion request, including `--delete-app-data`.
2. All deletion outside `$INSTDIR` goes through a ported minimal version of upstream's `uninstall-data.h` native helper, with its safety tests. The stock `--delete-app-data` `RMDir /r` bypass is stripped from the generated templates exactly as upstream strips it — fixed file names are not a defense, because a parent directory in the chain can itself be a junction.
3. Reject protected roots and any target containing or contained by `$INSTDIR` or the resolved `DSH_HOME`.
4. Honor the persisted path record, `--user-data-dir`, and `DSH_HOME` when locating targets; decline cleanup when a target cannot be resolved and verified.
5. Cleanup is best-effort, not a no-residue guarantee: locked files held by a still-running Host or agent subprocess are skipped and reported observably instead of failing the uninstall mid-delete. "Tolerates locked files" and "leaves no residue" cannot both be promised; the contract is best-effort removal with reported residue.
6. Never remove credentials-bearing or user-content roots (`$DSH_HOME` including `electron/`, `~/.agents`, workspaces) under any uninstaller flag.

## Other platforms

Only Windows has an uninstaller. For parity the design should:

- publish an accurate platform "clean uninstall" list in user-facing docs: macOS `~/Library/Application Support/Rivetdeck` and `~/Library/Caches/rivetdeck-updater`; Linux `${XDG_CONFIG_HOME:-~/.config}/Rivetdeck` and `${XDG_CACHE_HOME:-~/.cache}/rivetdeck-updater`; optional `~/.dsh` with a warning that it is shared;
- defer any in-app "Reset application data" (Settings) or `dsh`-side cleanup command to a separately scoped change; reset of settings and deletion of user-installed packages are distinct operations;
- treat MSIX parity as unverified, not free: the OS removes the package and its virtualized file data, but Microsoft distinguishes virtualized files from pre-existing non-virtualized ones, which can persist. Current Store smoke only confirms package unregistration, and runtime smoke uses a custom `userData` outside the package, so the default toolchain location's fate under Store uninstall is unverified. Required coverage: a first-time Store install, a Store install over existing NSIS data, and a Store install with custom paths outside the package.

## Review conclusions

| Topic | Conclusion |
| --- | --- |
| Design choice | Candidate D added and recommended: clean toolchains and caches by default, preserve preferences and credentials, full removal only via explicit option. Option A remains available only as a deliberate product decision. |
| `$DSH_HOME/electron` | The uninstaller never removes it; `python-user/` and `node-global/` hold user-installed packages, not cache. |
| Native deletion helper | Port the minimal upstream implementation plus its safety tests into `apps/electron`; all deletion paths funnel through it; strip the stock `--delete-app-data` recursive-delete bypass. |
| Uninstaller localization | Owned by downstream `apps/electron` installer resources; NSIS localized text generated at build time. |
| In-app reset | Scoped independently; "reset settings" and "remove user-installed packages" are separate operations; may ship later. |
| Other platforms | This phase ships accurate manual cleanup documentation only; Store parity requires the verification matrix above. |
| `--delete-app-data` | Retained for compatibility; under candidate D it requests explicit full `userData` cleanup; update and `/KEEP_APP_DATA` protections take precedence. |

## Acceptance criteria for implementation

- Normal interactive and silent uninstalls remove the tiered cleanup targets and preserve settings, credentials, and persisted browser storage.
- Updates and same-product re-installs to a different directory preserve all data.
- A `DSH_HOME` used for an earlier launch and later switched away remains protected on uninstall, because the history set retains it.
- A historical `userData` left behind by a `--user-data-dir` switch follows the same tiered policy: settings and persisted storage survive by default while rebuildable subdirectories are still removed.
- Junction and symlink targets inside any deletion root are unlinked, not traversed; content behind them survives.
- A deletion target overlapping any protected path is skipped entirely, and the skip is observable in the reported residue.
- A transiently-set `DSH_HOME` or `--user-data-dir` (recorded, then absent from the uninstall environment) is still honored.
- A legacy install with no history record — or a record marked incomplete — that once used a nested `DSH_HOME` inside `userData` cannot prove isolation; `--delete-app-data` skips the `userData` root and reports the residue instead of deleting historical sessions.
- Locked files produce reported residue, not a failed or partial-silent uninstall.
- The Store verification matrix (first install, existing NSIS data, custom external paths) runs before MSIX parity is claimed.
