# DeepSeek Harness Desktop Architecture and Development Guide

English | [中文](architecture.zh.md)

> Status: **Downstream architecture specification**
>
> Scope: `cherrchen/deepseek-harness-electron`, especially `apps/electron/**`
>
> Audience: maintainers, coding agents, reviewers, and future contributors
>
> This document distinguishes **CURRENT** behavior that already exists on `develop` from **TARGET** architecture that guides future development. Do not describe TARGET behavior as already implemented.

## 1. Purpose

DeepSeek Harness Desktop is a downstream Electron desktop application built on top of the upstream `deepseek-ai/deepseek-harness` repository.

The project has two simultaneous goals:

1. Follow upstream DeepSeek Harness closely with minimal long-lived downstream modification.
2. Provide a first-class macOS, Windows, and Linux desktop application with native capabilities and downstream-specific product features.

The architecture intentionally separates three concerns:

* **Electron Runtime** owns desktop lifecycle, operating-system integration, security boundaries, packaging, and the supervised Harness process.
* **DeepSeek Harness** remains the application/runtime core: agents, sessions, tools, models, storage, profiles, Cordis composition, Host APIs, and the shared client runtime.
* **Feature Plugins** are the preferred home for new independent downstream features and custom product UI.

The governing architectural principle is:

> **Electron is the stable desktop platform layer; DSH/Cordis plugins are the extensible product feature layer.**

We do **not** currently intend to make the Electron desktop application itself a Cordis plugin. We also do **not** intend to build a second standalone product frontend inside `apps/electron/src/renderer`.

## 2. Normative language

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

For factual descriptions:

* **CURRENT** means implemented on the current `develop` branch.
* **TARGET** means the intended architecture for future work and may not yet exist.
* If this document's CURRENT description conflicts with the code, the code is the source of truth and this document MUST be corrected.
* If a new implementation conflicts with a TARGET rule, the implementation SHOULD be changed unless an explicit architecture decision updates this document.

## 3. Repository ownership boundary

This repository is a downstream fork of `deepseek-ai/deepseek-harness`.

| Area                         | Ownership  | Rule                                                                                                                          |
| ---------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/**`                | Upstream   | Upstream-owned by default; do not add downstream desktop behavior outside the exception below.                               |
| `apps/cli/**`                | Upstream   | Do not use as a downstream customization surface.                                                                             |
| `apps/web/**`                | Upstream   | Desktop MUST NOT depend on modifying this app for desktop-only UI.                                                            |
| `docs/**` (except `docs/electron/**`) | Upstream   | Avoid downstream-only edits that create synchronization conflicts.                                                            |
| `docs/electron/**`           | Downstream | Desktop architecture and other downstream-owned documentation under `docs/`.                                                  |
| `apps/electron/**`           | Downstream | Primary home of desktop runtime, desktop integrations, and downstream desktop plugins.                                        |
| `AGENTS.downstream.md`       | Downstream | Fork-specific development and Git rules.                                                                                      |
| downstream desktop workflows | Downstream | Desktop CI/CD, release, promotion, and upstream-sync integration.                                                             |

A future desktop feature MUST NOT be implemented by scattering changes across upstream-owned packages simply because that is locally convenient.

# Part I — CURRENT Architecture

## 4. Current architecture summary

The current application is best described as:

> **Electron-owned frontend + supervised DSH Web sidecar + typed desktop capability bridge**

It is no longer a simple Electron wrapper around `apps/web`.

```text
┌───────────────────────────────────────────────────────────────┐
│                         Operating System                      │
│                  macOS / Windows / Linux                      │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                         Electron Main                         │
│                                                               │
│  Window / Tray / Menu / Updater / Dialog / Clipboard / Shell │
│  Notification / Theme / Process supervision / Security policy│
│                                                               │
│  ┌─────────────────────────┐    ┌───────────────────────────┐ │
│  │ Typed IPC + Preload     │    │ Custom scheme / proxy     │ │
│  │ window.deepseekDesktop  │    │ dsh-electron://localhost  │ │
│  └────────────┬────────────┘    └─────────────┬─────────────┘ │
└───────────────┼───────────────────────────────┼───────────────┘
                │                               │
                │ desktop capability            │ Host HTTP / WS
                │ calls                         │ transport
                ▼                               ▼
┌───────────────────────────────┐   ┌───────────────────────────┐
│ Electron-owned Renderer       │   │ Supervised DSH process    │
│                               │   │                           │
│ dsh-electron://localhost      │   │ `dsh web`                 │
│                               │   │ 127.0.0.1:<random-port>   │
│ AppWebEntry                   │   │                           │
│ @deepseek-ai/dsh-client-web   │   │ Cordis / DSH Host         │
│ upstream client plugin graph  │   │ agents / sessions / tools │
│ desktop bootstrap/shims       │   │ profiles / storage / APIs │
└───────────────────────────────┘   └───────────────────────────┘
```

Important consequences:

* BrowserWindow does **not** load the upstream `apps/web` application.
* BrowserWindow does **not** use the supervised Host loopback URL as its page origin.
* The Renderer is owned and built by `apps/electron`.
* The Renderer intentionally reuses the upstream DSH client runtime and client plugins.
* The upstream Host runs as a separate supervised `dsh web` process for compatibility.
* Native OS capabilities stay in Electron Main.

Primary implementation references:

* `apps/electron/src/main.ts`
* `apps/electron/src/renderer/main.ts`
* `apps/electron/src/renderer/bootstrap.ts`
* `apps/electron/src/preload/index.ts`
* `apps/electron/src/bridge-types.ts`
* `apps/electron/src/harness/**`
* `apps/electron/src/protocol.ts`
* `apps/electron/runtime/host.patch.yml`
* `docs/electron/plugin-lifecycle.md`

## 5. Current process topology

### 5.1 Electron Main

**CURRENT**

Electron Main is the desktop runtime owner.

It owns application and BrowserWindow lifecycle, tray/menu, updater, native theme, dialogs, clipboard, shell integration, notifications, window controls, custom protocol, Host transport, supervised process lifecycle, and Electron-local runtime resources.

Electron Main MUST remain the authority for privileged OS actions.

### 5.2 Supervised DeepSeek Harness process

**CURRENT**

Electron Main starts upstream DSH as a child process:

```text
Electron Main
    │
    │ spawn
    ▼
Windows: resources/core-runtime/node.exe with one hidden console
Other platforms: Electron executable with ELECTRON_RUN_AS_NODE=1
    │
    ▼
dsh web
    │
    ▼
127.0.0.1:<random-port>
```

On Windows the Host runs on the packaged Node.js, because `electron.exe` is a GUI-subsystem image: a process without a console makes Windows allocate a visible console for every console-subsystem descendant, which Windows 11 renders as a Windows Terminal window. The packaged Node.js is a console-subsystem image started with `windowsHide` and an inherited stdin device handle, so the Host holds one hidden console that job, ACL, and sandboxed child processes inherit; `CREATE_NO_WINDOW` alone leaves a console-subsystem child without any console, which a restricted token cannot create for its children. Other platforms keep Electron's Node-compatible child mode.

Core Host execution and plugin package operations are independent of Agent runtimes. Main owns the optional Node/Python Runtime Manager, versioned user-data generations, and a closed typed subscription API. No managed runtime is required to start the Host or client. The Desktop subprocess provider receives a version-2 policy containing only verified installed runtimes, searches request/project/user/ambient PATH before managed fallbacks, and excludes Host-only package-manager commands. Installation changes apply after restart. [Runtime environments](runtime-environments.md) owns lifecycle, migration, and proxy behavior.

The sidecar owns upstream Harness behavior:

```text
agents
sessions
tools
models
profiles
Cordis Host graph
Harness persistence
Host APIs
event streams
```

Electron does not reimplement these systems.

### 5.3 Electron-owned Renderer

**CURRENT**

The Renderer is built inside `apps/electron` and loaded from:

```text
dsh-electron://localhost/index.html
```

It starts the shared DSH client kernel using `AppWebEntry` from `@deepseek-ai/dsh-client-web`.

Therefore:

```text
OLD

Electron
  └─ apps/web


CURRENT

Electron
  └─ Electron-owned Renderer
       └─ @deepseek-ai/dsh-client-web
            └─ upstream client plugin graph
```

`apps/web` is not a desktop customization surface.

## 6. Current renderer bootstrap

**CURRENT**

Because BrowserWindow no longer loads Host-generated HTML, `apps/electron/src/renderer/bootstrap.ts` reconstructs the minimum upstream client bootstrap state.

It:

1. requests Host bootstrap through `window.deepseekDesktop.host.getBootstrap()`;
2. creates `window.__ModuleLoader__`;
3. loads Host client preload scripts;
4. installs `window.__DSH_BOOT__`;
5. starts `AppWebEntry`.

Renderer bootstrap MUST remain thin.

It MUST NOT become:

```text
installMarket()
installTerminal()
installGit()
installMcpManager()
installPromptLibrary()
...
```

Independent product functionality belongs in plugins.

## 7. Current Host transport

**CURRENT**

The supervised Host binds to loopback on a random port.

```text
Renderer
   │
   ├─ typed preload IPC
   └─ dsh-electron:// proxy
   │
   ▼
Electron Main
   │
   ▼
HttpHarnessTransport
   │
   ▼
127.0.0.1:<random-port>
   │
   ▼
DSH Host
```

The localhost HTTP/WebSocket sidecar is **not currently considered an architectural defect**.

It is an internal transport implementation. Replacing it would mean maintaining a second implementation of upstream bootstrap, request, stream, cancellation, reconnection, and plugin transport semantics.

Removing localhost is therefore not a current priority.

## 8. Current Desktop Capability Bridge

**CURRENT**

`window.deepseekDesktop` is the narrow Renderer-facing bridge.

It exposes explicit typed capability groups:

```text
host
app
dialog
clipboard
shell
notification
updater
theme
window
plugins
```

There is no generic `ipcRenderer.invoke()` escape hatch.

This is already the foundation of the future **Desktop Capability Contract**.

## 9. Current security boundary

**CURRENT**

BrowserWindow uses:

```text
contextIsolation = true
nodeIntegration   = false
sandbox           = true
```

The trust boundary is:

```text
Unprivileged Renderer / Client Plugins
                │
                ▼
           Typed Preload
                │
                ▼
          Closed IPC APIs
                │
                ▼
          Electron Main
                │
                ▼
            OS APIs
```

Future plugins MUST preserve this boundary.

A plugin MUST NOT receive raw Electron or Node access simply because it runs in Desktop.

## 10. Current runtime plugin infrastructure

**CURRENT**

Desktop assembles its required runtime plugins from two sources: directories under `apps/electron/runtime/plugins/` that Electron builds, and published npm packages listed in `dshElectron.runtimePlugins`. Public ecosystem plugins are exact production npm dependencies listed in `dshElectron.ecosystemPlugins`; every npm source keeps its published Host and Client artifacts.

```text
runtime/plugins/*          Desktop adapters, Electron carriers, and Desktop-only integration (build + link)
node_modules/@dsh-electron/*  runtime plugins (dshElectron.runtimePlugins) and ecosystem plugins (dshElectron.ecosystemPlugins)
runtime/host.patch.yml     Host overlay: required Desktop plugins only
scripts/build-runtime-plugins.mjs
src/runtime-plugins.ts     discovery, validation, and required-plugin profile linking
src/ecosystem-profile.ts   seed ecosystem plugins into the web profile as profile-owned installs
src/host-profile.ts        process-private Host resolution projection for ecosystem packages
src/host.ts                supervised Host entry with split persistence vs resolution dirs
src/ownership-overlay.ts   generate ownership patches for current profile layers
```

Startup validates and links **required runtime plugins** into `$DSH_HOME/profiles/node_modules/<package-name>` and `$DSH_HOME/profiles/web/node_modules/<package-name>` before the supervised Host starts. The shared dsh plugin package operation preinstalls missing ecosystem plugins once and repairs old Desktop links; Desktop does not write their shared installation state directly. The supervised Host resolves ecosystem packages through `$DSH_HOME/electron/host-profile`, which leaves shared profile packages untouched for concurrent CLI `dsh web`. `host.patch.yml` mounts required Desktop plugins. The web profile manages enablement for installed ecosystem bundles and subsequently installed plugins; after an ecosystem package is removed from that profile, the Desktop Host selects its bundled copy only in its private projection ([plugin lifecycle](plugin-lifecycle.md)).

The Desktop Capabilities package (`@dsh-electron/dsh-electron-desktop-capabilities`) is the Desktop Client composition root. It adapts `window.deepseekDesktop` into `ctx.desktop` and mounts internal feature plugins. Only renderer infrastructure and this package read the global bridge directly.

The directory-picker feature fills workspace directory-flow slots and calls `ctx.desktop.dialog.pickDirectory()`.

The brand feature always fills `sidebar.brand.mark`, `sidebar.brand.name`, and `conversation.hero.brand.mark` with DeepSeek Harness artwork, so Desktop does not depend on the upstream `DSH_CLIENT_BUILD_PROFILE=official` client build for product branding.

The upstream Web bundle provides the Plugins UI and agent tool. Electron’s `DesktopPluginManager` reports the effective mixed runtime inventory: Electron-owned packages use bundled implementation, patches, and versions; ordinary user plugins use the shared web profile implementation. `DesktopRuntime` serializes external CLI changes and UI operations on the HMR queue, then waits for Loader settlement. Package persistence stays with upstream operations on the shared web profile; the private projection is disposable. See [plugin lifecycle](plugin-lifecycle.md).

The [Network Settings page](network-settings.md) is an internal Desktop Client feature. It contributes a top-level `settings.section` entry and uses `ctx.desktop.network` for configuration, sanitized diagnostics, and connection tests; Main owns the policy, secrets, and restart. The native failure dialog can open this section without changing the selected route.

Git (`@dsh-electron/dsh-plugin-git@0.2.4`) is a bundled ecosystem plugin installed only from npm. Its client occupies `ctx.sidebarRight` / `sidebarRightTabs` and is listed in `dshElectron.ecosystemPlugins`. Desktop seeds a CLI copy into the shared web profile once. Electron Installed reports its resolved bundled version and source; Enable and Disable persist in the shared profile.

Theme Studio (`@dsh-electron/dsh-theme-studio@0.1.3`) is a preinstalled ecosystem bundle listed in `dshElectron.ecosystemPlugins`. Its canonical source is `cherrchen/dsh-theme-studio`; this repository keeps no copy of it. The package registers **Settings → General → Themes** and calls `ctx.theme.overrideTokens()`; Electron Installed lists its actual bundled runtime package. Its published peer declarations include `0.1.7-rc.2`.

```text
Feature Plugin
     │
     │ ctx.desktop.*
     ▼
Desktop Capability Provider
     │
     ▼
window.deepseekDesktop
     │
     ▼
Electron Main
     │
     ▼
Native OS APIs
```

Every directory under `runtime/plugins/<name>/` is rebuilt from source. Portable runtime plugins declared in `dshElectron.runtimePlugins` likewise install, package, and link their published artifacts without rebuilding. Portable product features use independently published `@dsh-electron/dsh-plugin-*` packages; Electron installs, packages, and links their published artifacts without rebuilding or converting them.

# Part II — Architecture Principles

## 11. Keep Electron Core stable

Electron is infrastructure, not the general product feature layer.

Electron Core owns:

```text
BrowserWindow
application lifecycle
single-instance behavior
tray
menus
updater
native dialogs
native clipboard implementation
native notifications
native theme
shell integration
protocol
preload
IPC validation
security policy
Host process supervision
installer / packaging / signing integration
```

These SHOULD NOT be converted into Cordis plugins merely for architectural symmetry.

We explicitly reject the requirement that:

> "Desktop itself must be a plugin."

## 12. Keep Renderer bootstrap thin

`apps/electron/src/renderer` is a carrier/bootstrap layer for DSH Client.

It MAY contain:

* renderer entry;
* Host bootstrap compatibility;
* transport adapters;
* narrowly scoped compatibility shims;
* Electron carrier-specific chrome integration.

It SHOULD NOT become:

```text
apps/electron/src/renderer/
├─ market/
├─ terminal/
├─ git/
├─ mcp/
├─ models/
├─ prompts/
├─ analytics/
└─ file-explorer/
```

That would recreate a second monolithic Web application.

## 13. Independent product features are plugins

Good plugin candidates include:

```text
plugin marketplace
Git integration
terminal product UI
MCP manager
model manager
prompt library
agent/preset management
workspace extensions
session analytics
developer tools
desktop-specific settings
sidebar contributions
conversation extensions
```

Do not micro-pluginize:

```text
Button
Modal
Dropdown
one settings row
helper function
small internal React component
```

The goal is feature modularity, not "everything is a plugin."

## 14. Plugins request capabilities; they do not own Electron

Required dependency direction:

```text
Feature Plugin
      │
      ▼
Desktop Capability Contract
      │
      ▼
Preload / IPC
      │
      ▼
Electron Main
      │
      ▼
OS
```

Forbidden direction:

```text
Feature Plugin
      │
      ├─ import electron
      ├─ import ipcRenderer
      ├─ use Node directly
      └─ bypass privilege validation
```

## 15. Follow upstream capability seams first

Before creating a Desktop-specific API, inspect existing DSH/Cordis extension points:

```text
ctx services
Cordis events
Host/client plugin composition
Conversation nodes
Settings cards
Commands
Jobs
Shell/filesystem/terminal providers
Session events
Agent events
Client UI slots
```

If upstream already provides the correct abstraction, use it.

Only the portion that genuinely requires Desktop authority should cross into Electron.

## 16. Minimize upstream fork surface

Desktop-specific behavior SHOULD stay in:

```text
apps/electron/**
```

Avoid permanent downstream changes to:

```text
apps/web/**
packages/**
```

unless they are genuinely upstream-compatible changes intended for upstream contribution.

# Part III — TARGET Architecture

## 17. Target architecture

**TARGET**

```text
                 Electron Runtime
                         │
             Desktop Capability Contract
                         │
                         ▼
┌─────────────────────────────────────────────────┐
│         Electron-owned Renderer                 │
│                                                 │
│ thin bootstrap / transport carrier              │
│                 │                               │
│                 ▼                               │
│              AppWebEntry                        │
│                 │                               │
│          DSH Client Runtime                     │
│                 │                               │
│      ┌──────────┼────────────┐                  │
│      ▼          ▼            ▼                  │
│ upstream    desktop       third-party           │
│ plugins     plugins       plugins               │
└─────────────────────────────────────────────────┘
                         │
                         ▼
                 Supervised DSH Host
```

The intended steady-state rule is:

> **Electron Runtime stays small and stable; product capability grows primarily through plugins.**

## 18. Desktop Capability Contract

**TARGET**

`DeepseekDesktopBridge` should evolve into a deliberately maintained contract.

Each capability MUST:

1. describe a user/native capability rather than an Electron primitive;
2. expose the minimum operation required;
3. validate security-sensitive arguments in privileged code;
4. be typed;
5. use explicit channels;
6. define failure behavior;
7. avoid exposing raw Electron/Node objects;
8. return explicit disposers for subscriptions.

Prefer:

```text
desktop.dialog.pickDirectory()
desktop.notification.show(...)
desktop.shell.openExternal(...)
```

Do not expose:

```text
desktop.invoke("anything", payload)
desktop.electron.shell
desktop.rawIpc
```

## 19. Feature-plugin model

**CURRENT**

Downstream plugin ownership is split by runtime requirement:

```text
apps/electron/runtime/plugins/
├─ desktop-capabilities/            Client composition root
│  └─ src/client/features/          directory-picker, brand, network-settings, plugin-manager
└─ desktop-network-subprocess/      independent Host provider

npm registry
├─ @dsh-electron/dsh-theme-studio  ecosystem plugin (dshElectron.ecosystemPlugins)
└─ @dsh-electron/dsh-plugin-*      ecosystem plugin (dshElectron.ecosystemPlugins)
```

The architectural rules:

* feature code remains downstream-owned;
* feature integration uses DSH/Cordis;
* Renderer bootstrap does not initialize every product feature;
* privileged operations remain behind the capability contract;
* ordinary Desktop feature development does not require upstream modifications.

Four plugin categories are:

### Portable DSH Plugin

```text
Plugin
  └─ only DSH capabilities
```

It can work across Web and Desktop.

### Desktop-aware DSH Plugin

```text
Plugin
  ├─ normal DSH behavior
  └─ optional native Desktop enhancement
```

Prefer progressive enhancement when possible:

```text
Web
  -> normal feature

Desktop
  -> normal feature + approved native capability
```

The main fiber declares only portable requirements. An optional `ctx.inject(['desktop'], ...)` child fiber stays pending without `desktop`, activates when a compatible provider appears, and disposes only the native enhancement when that provider unloads. A public plugin declares the smallest structural `desktop` interface it consumes and never imports an Electron provider.

### Desktop-required Adapter

A Desktop-required Client adapter is an internal Cordis feature of `@dsh-electron/dsh-electron-desktop-capabilities`. It injects `desktop` and occupies product slots from a child fiber. It is not a separate `@dsh-electron/dsh-electron-*` Loader package. A Host-only provider such as `@dsh-electron/dsh-electron-network-subprocess` remains an independent `runtime/plugins/` package and overlay row.

### Preinstalled portable ecosystem plugins

A portable `platform: web` public package can ship as a preinstalled ecosystem bundle when users own its enablement. It uses upstream DSH services and its published npm artifact is installed, packaged, and linked without rebuilding. Theme Studio and Git are declared in `dshElectron.ecosystemPlugins`; users can disable either in the shared web profile.

## 20. Native implementation versus feature ownership

Example: Terminal.

```text
Terminal Feature Plugin
├─ UI
├─ tabs
├─ state
├─ commands
└─ DSH integration
        │
        ▼
native terminal/PTY capability
        │
        ▼
Electron Main
```

The plugin owns product behavior.

Electron owns privileged mechanism.

# Part IV — Milestones

## 21. Milestone 1 — Standalone Electron Renderer

**Status: DONE**

Goal:

> Stop using `apps/web` as the Electron page.

Result:

```text
Electron Renderer
    │
    ▼
@deepseek-ai/dsh-client-web
    │
    ▼
DSH client plugin graph
```

Do not regress this milestone.

## 22. Milestone 2 — Native Desktop Capability Layer

**Status: DONE**

Goal:

> Move privileged desktop behavior behind Electron Main and expose narrow typed capabilities.

Completed areas include:

```text
typed preload bridge
closed IPC channels
directory picker
clipboard
shell
notification
updater
theme
window controls
Renderer hardening
```

Future Renderer/plugin code MUST NOT bypass this boundary.

## 23. Milestone 3 — Pluginized Feature Layer

**Status: DONE**

Goal:

> Establish a repeatable model where downstream custom UI and independent Desktop product features live as DSH/Cordis plugins while Electron stays a stable runtime.

Completed areas include:

```text
generic runtime plugin builder (build-runtime-plugins.mjs)
generic bundled plugin discovery and linking (runtime-plugins.ts)
Desktop Capability Provider (ctx.desktop)
directory picker migrated to capability service
host.patch.yml explicit composition
architecture and regression tests
```

Acceptance criterion (met):

A developer can add a new independent Desktop Client feature without editing `apps/web`, upstream core packages, `renderer/main.ts`, generic IPC, or generic infrastructure — by adding an internal feature under `desktop-capabilities/src/client/features/`. A new Host-only provider still adds a `runtime/plugins/` directory or a published runtime plugin in `dshElectron.runtimePlugins`, and a Loader row in `host.patch.yml`.

## 24. Optional Milestone 4 — Transport Optimization

**Status: DEFERRED / OPTIONAL**

The previous idea of replacing:

```text
Electron Main
  -> localhost HTTP/WebSocket
  -> dsh web
```

with a custom process-IPC carrier is no longer mandatory.

Reconsider it only when evidence exists, such as:

```text
measurable performance problems
real port/network conflicts
security constraints
packaging reliability problems
upstream-supported non-Web transport
maintenance cost exceeding replacement cost
```

Do not replace mature upstream transport for architectural purity.

# Part V — Feature Placement

## 25. Decision rule

If it inherently requires Electron/OS privilege:

> Put the privileged implementation in Electron Core / Desktop Services.

If it is an independent product feature or UI domain:

> Make it a DSH/Cordis feature plugin.

If it is generic Harness behavior useful to all clients:

> Prefer an upstream DSH capability or upstream-compatible contribution.

If it is a small component internal to a feature:

> Keep it a normal component/module.

If Desktop-specific UI appears to require modifying `apps/web`:

> Stop and redesign around an extension point/plugin.

## 26. Ownership examples

| Requirement                 | Preferred owner                         |
| --------------------------- | --------------------------------------- |
| Window lifecycle            | Electron Core                           |
| Tray/menu                   | Electron Core                           |
| Updater engine              | Electron Core                           |
| Installer/signing           | Electron/CI                             |
| Native directory chooser    | Electron Capability                     |
| Directory chooser UI        | DSH client plugin                       |
| Sidebar contribution        | DSH client plugin                       |
| Settings feature            | DSH client plugin                       |
| Git experience              | DSH plugin + optional native capability |
| Terminal experience         | DSH plugin + provider/native seam       |
| Agent/session/tool behavior | DSH/Cordis                              |
| Model capability            | DSH plugin/service                      |
| Host transport              | Electron Runtime                        |
| Small React component       | Parent feature module                   |

# Part VI — Anti-Patterns

## 27. Designs to avoid

Do not rebuild a downstream `apps/web` in `apps/electron/src/renderer`.

Do not scatter:

```text
if (isElectron) { ... }
```

through upstream packages.

Do not expose:

```text
window.deepseekDesktop.invoke(...)
ipcRenderer
```

Do not allow plugins to import Electron.

Do not pluginize infrastructure only for aesthetic consistency.

Do not replace upstream HTTP/WebSocket transport without a concrete measured reason.

Do not modify upstream packages to implement a downstream-only UI shortcut.

# Part VII — Security

## 28. Security invariants

The following MUST remain true:

1. Renderer has no Node integration.
2. Renderer uses context isolation.
3. Renderer remains sandboxed unless a documented security decision changes this.
4. BrowserWindow remains on the Desktop custom origin.
5. Arbitrary navigation is denied.
6. External URLs are validated and opened through Main.
7. No generic IPC API is exposed.
8. Native capability arguments are validated in privileged code.
9. Plugins receive capabilities rather than Electron objects.
10. The supervised Host remains loopback-only while sidecar transport is used.
11. New privileged APIs require explicit trust-boundary review.

# Part VIII — State Ownership

## 29. Harness state

Harness remains responsible for:

```text
profiles
settings
sessions
Harness plugin state
upstream credentials/storage
```

Do not create parallel Electron-owned copies of these concepts.

## 30. Electron state

Electron-specific data may live in Electron `userData`, such as:

```text
Chromium data
desktop update preference
desktop runtime metadata
generated Host overlay copy
```

General Harness state does not belong there.

# Part IX — Documentation and Agent Rules

## 31. Documentation responsibilities

`apps/electron/README.md` should remain a concise factual entry point covering:

```text
what Desktop is
build/run/test
CURRENT runtime architecture
native integrations
updates/packaging
security
link to architecture guide
```

A detailed downstream architecture document should live under:

```text
docs/electron/architecture.md
```

`AGENTS.downstream.md` should contain concise actionable architecture rules and link to the detailed document.

It should explicitly tell Agents:

```text
Desktop-only changes stay under apps/electron/** and docs/electron/**
Do not modify apps/web for Desktop-only UI
Do not modify upstream docs/** outside docs/electron/** for Desktop-only content
Keep Renderer bootstrap thin
Prefer plugins for independent features
Plugins must not import Electron
Native operations cross the typed capability contract
Do not replace loopback Host transport without justification
```

Do not duplicate this complete document into `AGENTS.downstream.md`.

## 32. Agent workflow

Before implementing architecture-sensitive Desktop work, an Agent should:

1. read `AGENTS.md`;
2. read `AGENTS.downstream.md`;
3. read this architecture document;
4. inspect current Electron code;
5. classify the change as Electron Core, Desktop Capability, Feature Plugin, upstream Harness change, or build/release concern;
6. choose the narrowest ownership layer;
7. avoid upstream-owned file changes unless justified;
8. add tests for changed boundaries;
9. update CURRENT docs only after behavior is implemented;
10. update TARGET docs only after an explicit architecture decision.

# Part X — Architecture Review

## 33. Review checklist

For non-trivial Desktop changes ask:

* Does this actually belong in Electron Core?
* Can an existing DSH/Cordis seam solve it?
* Should this independent feature be a plugin?
* Is `renderer/main.ts` becoming product-aware?
* Does this add Desktop-only code to `apps/web` or upstream packages?
* Does it broaden IPC privileges?
* Can Renderer/plugin code now access more OS authority?
* Does it require Node/Electron directly in the Renderer?
* Does it create a second source of truth for Harness state?
* Does it duplicate upstream transport/runtime behavior?
* Does it increase future upstream-sync conflicts?
* Are CURRENT and TARGET labels still accurate?

# Part XI — Architecture Decisions

## ADR-DESKTOP-001 — Electron remains the application/runtime

**Decision:** Keep the existing Electron application model rather than making Desktop itself a DSH plugin.

**Reason:** Window lifecycle, security, packaging, updater, native integration, and process supervision are infrastructure responsibilities.

## ADR-DESKTOP-002 — Reuse DSH client packages, not `apps/web`

**Decision:** Desktop owns its Renderer and directly boots `@deepseek-ai/dsh-client-web`.

**Reason:** This keeps upstream client/plugin compatibility while allowing Desktop to own its origin, bootstrap, security, and native integration.

## ADR-DESKTOP-003 — Native behavior uses a narrow typed capability contract

**Decision:** Electron Main owns OS privileges.

**Reason:** Privileged surface area remains explicit, typed, and reviewable.

## ADR-DESKTOP-004 — Independent downstream features are plugins

**Decision:** New custom product UI and feature domains should prefer DSH/Cordis plugins.

**Reason:** Prevent the Renderer from becoming a second monolithic frontend and minimize fork surface.

## ADR-DESKTOP-005 — Keep the supervised `dsh web` sidecar

**Decision:** Retain the internal loopback Host transport unless evidence justifies replacement.

**Reason:** It is already hidden from BrowserWindow and preserves upstream compatibility.

## ADR-DESKTOP-006 — Pluginization ends at feature boundaries

**Decision:** Do not pursue "everything is a plugin."

**Reason:** Pluginize independent product behavior, not infrastructure or tiny implementation components.

# Part XII — Final Direction

## 35. Long-term direction

The first two milestones built the Desktop platform.

The next stage is not another large Electron rewrite.

The development question changes from:

```text
How do we keep restructuring Electron?
```

to:

```text
How do we add product capabilities cleanly
on top of a stable Electron Runtime?
```

The final development model is:

```text
Upstream DeepSeek Harness
        │
        │ upstream sync
        ▼
DSH Core / Host / Client Runtime
        │
        ├──────────────────────────────┐
        │                              │
        ▼                              ▼
Upstream plugins                Downstream feature plugins
                                       │
                                       │ approved capability calls
                                       ▼
                             Desktop Capability Contract
                                       │
                                       ▼
                                Electron Runtime
                                       │
                                       ▼
                                  Operating System
```

The intended end state is:

> **Electron Core stays thin, privileged, and stable.**
>
> **DeepSeek Harness remains the application core.**
>
> **Custom downstream UI and product capabilities grow primarily as plugins.**
>
> **The typed Desktop Capability Contract is the controlled bridge between plugins and native OS behavior.**
>
> **The existing Host sidecar transport remains an internal compatibility mechanism until evidence justifies replacing it.**

This is the default direction for future Desktop development unless a later architecture decision explicitly supersedes it.
