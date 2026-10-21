# Agent Note: Electron uninstall uses tiered data cleanup

Status: implemented

English | [中文](2026-10-18-electron-uninstall-tiered-cleanup.zh.md)

## Problem

The stock electron-builder NSIS uninstaller removes only `$INSTDIR` and leaves every byte of application data behind. The downstream's residue is heavier than a typical Electron app's: `userData/managed-toolchains` holds downloaded Node and Python runtimes, Chromium caches grow to hundreds of megabytes, and the updater cache keeps downloaded installers. Deleting the whole `userData` root is not free either — it carries the manual-proxy configuration a proxied user needs before runtimes can be re-downloaded, still-usable encrypted credentials in `network-secrets/`, and persisted browser storage that holds real user state such as unsent drafts. The shared Harness home (`$DSH_HOME`) must never be removed, yet both `userData` and `DSH_HOME` are relocatable (`--user-data-dir`, transient environment), so an uninstaller trusting only its own process environment cannot prove which directories the app actually used.

## Decision

Windows uninstallation runs a compiled native helper (`installer/uninstall-data.cpp`, policy in `installer/uninstall-cleanup.h`) from `customUnInstall`; every deletion outside `$INSTDIR` funnels through it, and the stock `--delete-app-data` `RMDir /r` bypass is stripped from the projected NSIS templates exactly as upstream strips it.

Tiered cleanup removes only verified rebuildable targets — `managed-toolchains/`, `electron/toolchains/bin`, the named Chromium caches (`Cache/`, `Code Cache/`, `GPUCache/`, `DawnGraphiteCache/`, `DawnWebGPUCache/`, and per-partition equivalents), and the updater cache — each after ownership attribution and expected-inventory checks. `desktop-preferences.json`, `network-secrets/`, `network-startup-override.json`, `electron-host.patch.yml`, and all persisted browser storage stay. `--delete-app-data` escalates to whole-`userData` removal only while the path-history record proves completeness; update (`--updated`) and same-product replacement (`/KEEP_APP_DATA`) protections take precedence over every deletion request.

A line-oriented path-history record (`%APPDATA%\rivetdeck-path-history.ini`, beside the default userData so an unelevated process can always write it) merges each packaged launch's resolved `userData` and `DSH_HOME` under a cross-process writer lock. Recorded `dshHome` claims always protect; recorded `userData` claims locate cleanup candidates but never protect by themselves. A real uninstall appends `retired=1`, which drops that installation's candidates and completeness while keeping all home and unknown claims, so a reinstall cannot clean roots recorded only by an earlier installation.

Safety is proven, not assumed. A missing, damaged, retired, or unresolvable record makes history incomplete; incomplete history retains the open-inventory targets (named caches, runtime trees, updater cache) whole and forbids `--delete-app-data` full removal, because no inventory can exclude an unrecorded Harness home in an arbitrary subtree. Deletion candidates must verify product attribution through marker files and match expected inventories — foreign content skips the whole target rather than being emptied with it. Both the recorded path and its resolved junction or symlink target join the protection set; a protected path that cannot be resolved blocks every deletion whose safety cannot be proven without it. A target whose existence cannot be queried is reported as residue with its error, never read as absent.

## External precedents

The survey below is the review-time evidence for retention-by-default: the dominant pattern across agent CLIs and editors is to remove the binary, retain user state, and offer data deletion as an explicit opt-in or documented manual step. Sources are official documentation and issue trackers at the versions current when the design was reviewed.

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

Two observations drove the tier split. First, retention-by-default remains the dominant policy for settings, credentials, and session content; the counterexample (opencode) deletes by default but distinguishes keepable classes through `--keep-config`/`--keep-data` rather than treating all state as one unit — the same class split this design needed. Second, large rebuildable artifacts are the accepted deletion candidates: opencode removes its global cache and upstream removes `userData`; `managed-toolchains` and the updater cache belong to that class, while `desktop-preferences.json` and `network-secrets/` do not.

## Upstream port basis

The upstream `apps/desktop` app implements the cleanup model the downstream lacked; sources: `apps/desktop/installer/uninstall.nsh`, `apps/desktop/installer/uninstall-data.h`, `apps/desktop/scripts/installer.nsh`, `apps/desktop/scripts/windows-directory-installer.mjs` — see [Windows uninstall retains the Harness home](2026-09-08-desktop-uninstall-preserve-dsh-home.md) for its decision.

Ownership split: upstream removes all Electron-owned data on a real uninstall and never touches the Harness home — the install directory (including its bundled primary runtime), Electron `userData` (which also holds logs and crash reports), and the updater cache go; everything under `DSH_HOME`, including the app-specific `profiles/desktop` profile and lock, stays.

Structural difference: upstream's Node, pnpm, and Python ship inside the installer payload under `$INSTDIR` and are removed with the program. The downstream instead downloads managed Node/Python into `userData/managed-toolchains` after install, so its runtime residue problem does not exist upstream — the downstream must delete `userData` subtrees to reclaim those runtimes.

Uninstaller flow: `customUnInstall` calls `un.CleanData`, which does nothing under `${isUpdated}`, honors `/KEEP_APP_DATA` for same-product replacement from a different install directory, reads `DSH_HOME` only to protect it, removes `$APPDATA\${PRODUCT_FILENAME}`, `$APPDATA\${APP_PACKAGE_NAME}` when present, and `$LOCALAPPDATA\${DSH_UPDATER_CACHE_NAME}`, then prunes emptied parents up to a fixed stop directory. `windows-directory-installer.mjs` strips the electron-builder app-data deletion block so removal happens only through the native helper.

Deletion safety: because `$DSH_HOME/profiles/*/node_modules` and toolchain trees contain junctions and symlinks, a naive recursive delete can escape into linked targets. The ported helper normalizes and rejects malformed paths, filesystem roots, and protected known folders; rejects targets containing or contained by `$INSTDIR` or the configured Harness home; pins parent directories with open handles and refuses reparse-point roots; removes trees without following links; and attempts every sibling, reporting the first error while tolerating locked-file residue so a still-running Host cannot fail the uninstall.

The limit that forced the path-history record: upstream reads `DSH_HOME` only from the uninstall process's own environment, which protects the default and permanently-set cases but cannot recover a transiently-set home or a historical `--user-data-dir`. A `DSH_HOME` once pointed inside `userData` could put sessions inside a deletion root, so the design required persisted discovery rather than environment-only trust.

## Alternatives considered

**Full `userData` removal by default (upstream-aligned).** Rejected as the default because it discards proxy configuration, update channel, runtime onboarding state, and still-usable encrypted credentials, and can leave a proxied user unable to re-download runtimes after reinstall. Retained only as the explicit `--delete-app-data` request, gated on complete history.

**Chrome-style opt-in page.** An assisted-uninstaller "also remove application data" choice (default: keep; `--delete-app-data` for silent mode) was rejected: it adds a custom uninstaller page plus bilingual native localization, and still leaves the toolchain residue for most users — the tiered default already reclaims the large residue without a choice the user must understand.

**Flag-only.** Keeping stock `--delete-app-data` semantics extended to the updater cache was rejected: the flag is effectively undiscoverable, so the residue stays the norm.

## Deferred

- In-app "Reset application data" (Settings) or a `dsh`-side cleanup command: resetting settings and deleting user-installed packages are distinct operations, scoped independently of uninstall.
- MSIX parity verification: the OS removes the package and its virtualized file data, but Microsoft distinguishes virtualized files from pre-existing non-virtualized ones, which can persist, and `~/.dsh` is outside virtualization. Required coverage before parity is claimed: a first-time Store install, a Store install over existing NSIS data, and a Store install with custom paths outside the package.

## Consequences

Uninstall reclaims the large rebuildable residue while a reinstall keeps working proxy configuration, credentials, and browser state. Locked files held by a still-running Host or agent subprocess produce reported residue instead of a failed or partial-silent uninstall. Application data is per-user: uninstalling under a different account than the one that used the product reaches only that account's roots and record. Builds predating the `Rivetdeck` product name wrote `%APPDATA%\DeepSeek Harness`, which no record can name — removing it is a manual step. Chromium directories outside the named cache list (`Crashpad`, `Service Worker`, and other diagnostic or registered-state directories) stay until `--delete-app-data` with complete history.

Native regressions cover refused roots, protected-home overlap and junction resolution, pinned-rename blocking, locked and read-only files, empty-parent pruning, history parsing and retirement, inventory verification, attribution, tiered cleanup, enumeration and attribute-query faults, and report-write independence. Desktop CI runs install/uninstall scenarios covering updates, replacements, legacy and incomplete history, and the `--delete-app-data` escape.
