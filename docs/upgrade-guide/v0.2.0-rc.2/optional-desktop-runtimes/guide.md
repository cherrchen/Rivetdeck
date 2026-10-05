---
kind: upgrade-guide
description: "Desktop Agent tasks require an explicitly installed managed runtime when no project or system interpreter is available."
---
# Desktop Node.js and Python become optional

English | [中文](guide.zh.md)

## Change

Desktop installers omit the complete Node.js/npm/npx and Python/pip distributions. Users whose Agent tasks relied on these bundled interpreters must choose whether to install managed runtimes. Desktop Host, chat, and plugin management retain their Core executor and start without either optional runtime. Existing application resources and system interpreters are not migrated into managed storage. Python user packages and npm global tools keep their `$DSH_HOME/electron/{python-user,node-global}` locations; upgrading does not move or delete them.

## Migration

1. On first launch after upgrading, select Node.js, Python, both, or **Skip for now** in Optional Runtime Environments. Skip saves the choice and leaves Desktop available.
2. Open **Settings → Network & Runtimes** whenever a task needs a managed interpreter. Download each runtime independently and restart Desktop to activate Agent fallback paths. Project, user, and system PATH entries keep priority.
3. Confirm the selected runtime is Installed and inspect its version and user-data location. Download failure permits Retry without discarding another successful installation. Removal of an active runtime completes after restart and preserves Core and project files.
4. Run an existing npm global command and import a Python user package using the selected interpreter. Python console scripts tied to the old bundled interpreter need entry-point regeneration: use `python -m pip install --user --force-reinstall <package>` through the managed shim, or reinstall from a local wheel. Recreate project virtual environments that reference the old bundled interpreter. A new Python minor version can also require package reinstallation.
5. Later managed Python reinstalls and updates retain predecessor interpreters for existing commands and virtual environments. Explicit Python removal deletes these interpreters after restart; recreate dependent environments or reinstall their packages before using them again.

See [Runtime Environments](../../../electron/runtime-environments.md) for lifecycle and network behavior.
