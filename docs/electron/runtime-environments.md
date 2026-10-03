# Desktop Runtime Environments

English | [中文](runtime-environments.zh.md)

Desktop starts with no managed Node.js or Python. Core execution belongs to Electron: macOS/Linux use Electron's Node-compatible child mode, while Windows ships only a console-subsystem `node.exe` and its license in `resources/core-runtime`. The hidden-console stdin inheritance remains in `spawnHarnessChild`. Fresh Core profile initialization uses an offline package operation with no dependencies. Ecosystem registry reconciliation runs after the client window loads, retains bundled plugin availability on failure, and is cancelled/drained before shutdown. The Host and bundled pnpm use this Core executor; optional runtime removal cannot remove it.

## Setup and migration

The client shell displays an optional setup dialog once per Desktop user-data profile. Node and Python start unselected. Skip persists onboarding completion without downloading anything. Settings → Network & Runtimes remains available after Skip, failure, or removal. Existing users receive the dialog once when the feature is introduced. App updates and later runtime removal do not reset completion. Legacy bundled runtimes and system interpreters are neither copied nor reported as managed installations.

## Lifecycle and storage

Main owns independent runtime operations and shares their snapshots with onboarding and Settings. Downloads use the repository lockfile's fixed HTTPS URL and SHA256, secure archive validation/extraction, interpreter version checks, npm/npx checks, and Python ssl/sqlite3/ctypes and pip checks. A failure in one runtime retains the other. Failed installs expose a translated category and retain technical details in Main logs. Cancellation waits for cleanup; interrupted staging is cleared before Host startup and reported for retry.

Each verified generation lives under `userData/managed-toolchains/<runtime>/<version>/<platform-arch>/<generation>`. Downloads and extraction remain in separate staging. Main atomically writes the active selector only after verification and immutable rename. Updates install a new generation, retain the previous one until restart, and report update availability when the pinned version differs. App updates preserve user-data installations without automatic downloads.

Installation and update require restart before Agent fallback paths change. Runtime removal is deferred until restart, preserving subprocesses that use either Agent fallback paths or explicit interpreter paths. Main removes only the selected managed generation and retired generations; it retains user package directories, project files, system interpreters, and Core. Quit drains installation operations before stopping Network Runtime.

## Network and executable selection

Main downloads through an Electron Session registered with the existing Desktop proxy applier. Default preserves Chromium routing, Direct explicitly bypasses proxies, and System/Manual use the Network Runtime Gateway without a direct fallback. Redirects must remain HTTPS. Network epoch changes cancel active installations; Settings changes restart the application. An offline install reports failure without blocking the Host or setup dismissal.

Agent subprocesses preserve explicit request, project, user, and ambient PATH priority. Only verified managed runtimes add their command directories and managed shims as fallbacks. Missing managed runtimes remain absent; executable lookup uses other available sources or reports executable-not-found. Core package-manager commands use a Host-only path excluded from this policy.
