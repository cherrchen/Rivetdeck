# Cleaning Up Rivetdeck User Files

English | [中文](cleanup-user-files.zh.md)

This guide lists the files Rivetdeck leaves behind after removal and how to delete what remains on each platform. Uninstall removes the program and rebuildable data only; the locations below hold settings, credentials, browser storage, or shared agent data that are never deleted on their own. The full ownership and safety policy lives in the [Uninstall and Data Cleanup](../uninstall-data-cleanup.md) design document.

## Windows (NSIS installer)

The assisted NSIS uninstaller removes the install directory, `managed-toolchains/`, `electron/toolchains/bin`, named Chromium cache directories (`Cache/`, `Code Cache/`, `GPUCache/`, `DawnGraphiteCache/`, `DawnWebGPUCache/`, and their per-partition equivalents), and `%LOCALAPPDATA%\rivetdeck-updater`. Named caches are removed only with complete path history; missing or incomplete history leaves them intact and lists them in the residue report. Reinstalling over legacy user data keeps history incomplete. Updates and uninstaller replacement delete no data at all.

| Location | Contents | After uninstall |
| --- | --- | --- |
| `%APPDATA%\Rivetdeck` | `desktop-preferences.json`, `network-secrets/`, `network-startup-override.json`, Cookies, `Local Storage/`, `IndexedDB/`, non-cache session-partition data | Preserved — delete the folder manually to remove it |
| `%APPDATA%\Rivetdeck-uninstall-residue.log` | Skipped targets and removal failures from the last uninstall | Delete manually |
| `%LOCALAPPDATA%\rivetdeck-updater` | Downloaded update packages | Removed by the uninstaller |
| `%APPDATA%\rivetdeck-path-history.ini` | Record of every `userData` and `DSH_HOME` root the product used | Preserved — it is what lets a later uninstall protect or remove the right roots; delete manually if unwanted |

Running `"Uninstall Rivetdeck.exe" --delete-app-data` requests removal of the whole `%APPDATA%\Rivetdeck`. It proceeds only when the install's path-history record exists and is complete; otherwise full removal is skipped, named caches are retained, and the residue log reports both. To delete it regardless, remove `%APPDATA%\Rivetdeck` manually.

## macOS

There is no uninstaller: drag `Rivetdeck.app` to the Trash. To remove the remaining data, delete `~/Library/Application Support/Rivetdeck`, which holds preferences, network secrets, and browser storage, and `~/Library/Caches/rivetdeck-updater`, which holds downloaded update packages.

## Linux

The AppImage is a single file — delete it. The DEB package removes `/opt/Rivetdeck`. To remove the remaining data, delete `~/.config/Rivetdeck`, which holds preferences, network secrets, and browser storage, and `${XDG_CACHE_HOME:-~/.cache}/rivetdeck-updater`, which holds downloaded update packages.

## Shared roots — never removed

The following locations belong to the Harness or to you and are never removed by any uninstall or cleanup flow:

- `~/.dsh` (`$DSH_HOME`, overridable through the `DSH_HOME` environment variable; `%USERPROFILE%\.dsh` on Windows) — sessions, settings, `.credentials.yaml`, plugins, and `electron/` user-installed packages. It is shared with other Harness-based tools, so delete it manually only when nothing else uses it.
- `~/.agents` — skills shared across agent tools.
- Workspace directories — your own projects.

## Custom locations

If the app ever ran with `--user-data-dir` or a different `DSH_HOME`, the `rivetdeck-path-history.ini` record beside `%APPDATA%` lists every root it used.
