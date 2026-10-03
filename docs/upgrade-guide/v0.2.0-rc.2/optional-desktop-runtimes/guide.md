---
kind: upgrade-guide
description: "Desktop Agent tasks require an explicitly installed managed runtime when no project or system interpreter is available."
---
# Desktop Node.js and Python become optional

English | [中文](guide.zh.md)

## Change

Desktop installers omit the complete Node.js/npm/npx and Python/pip distributions. Users whose Agent tasks relied on these bundled interpreters must choose whether to install managed runtimes. Desktop Host, chat, and plugin management retain their Core executor and start without either optional runtime. Existing application resources and system interpreters are not migrated into managed storage.

## Migration

1. On first launch after upgrading, select Node.js, Python, both, or **Skip for now** in Optional Runtime Environments. Skip saves the choice and leaves Desktop available.
2. Open **Settings → Network & Runtimes** whenever a task needs a managed interpreter. Download each runtime independently and restart Desktop to activate Agent fallback paths. Project, user, and system PATH entries keep priority.
3. Confirm the selected runtime is Installed and inspect its version and user-data location. Download failure permits Retry without discarding another successful installation. Removal of an active runtime completes after restart and preserves Core and project files.

See [Runtime Environments](../../../electron/runtime-environments.md) for lifecycle and network behavior.
