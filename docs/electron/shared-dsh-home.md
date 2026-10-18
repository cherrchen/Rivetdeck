# Sharing the Harness Home Between Desktop and CLI

English | [中文](shared-dsh-home.zh.md)

## Summary

Rivetdeck and CLI `dsh --profile web` share one Harness home (`~/.dsh`), giving you one profile, one session history, and one set of plugins and settings across both apps. When the CLI is newer than the bundled Harness, sessions it writes can become unreadable inside the app. This page describes what is shared today, the symptoms of version skew, and the workarounds currently available.

## Contents

- [What is shared](#what-is-shared)
- [Typical usage](#typical-usage)
- [When versions differ](#when-versions-differ)
- [What you can do today](#what-you-can-do-today)
- [Rollback path](#rollback-path)

<a id="what-is-shared"></a>

## What is shared

Both apps read and write the same files under `$DSH_HOME` (default `~/.dsh`, overridable through the `DSH_HOME` environment variable). Nothing is copied between the two; they operate on one store.

| Path | What it holds | What that means for you |
| ---- | ------------- | ----------------------- |
| `sessions/` | All Session logs, grouped by project directory | One session history appears in both the app sidebar and CLI |
| `profiles/web/` | The shared profile's composition: `cordis.patch.yml` (including current Settings values), `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `compatibility.json`, installed plugins. The home-root `cordis.patch.yml` composes above it | A plugin installed or a setting composed once applies to both apps |
| `storages/` | Shared KV data such as the session list cache and workspace state | Both apps see the same derived state |
| `attachments/` | Content-addressed images and files referenced by sessions | Attachments work in whichever app opens the session |
| `.credentials.yaml`, `.env` | Provider credentials and environment variables | Configure once, use from both apps |
| `settings.yaml`, `settings.yaml.imported` | Legacy Settings file, imported once into the profile patch and then renamed | Historical only — current Settings values live in the profile patch |
| `electron/` | Desktop-private state (host profile projection, plugin state) | Never shared; CLI ignores it |

<a id="typical-usage"></a>

## Typical usage

You can keep the desktop app open for GUI work and still run `dsh --profile web` in a terminal on the same machine. A session started in one app shows up in the other, and you can continue it in either. Plugin installs, profile edits, and settings changes made on one side are visible to the other after a restart.

Both apps may run at the same time. A per-session write lock (`session.lock` in each Session directory) prevents two writers from editing one session at once — the second writer is refused with `SessionAlreadyOwnedError`. The lock protects concurrent writes only; it cannot tell apart harness versions. On POSIX the lock is an inode-bound flock that follows a renamed directory; on Windows it is a named semaphore derived from the resolved path, so it survives directory replacement while open handles block renames instead.

<a id="when-versions-differ"></a>

## When versions differ

Compatibility is one-way. A newer harness reads older Session logs through its migration catalog and publishes a successor generation when it writes. An older harness never falls back: it picks the newest generation file and refuses what it cannot interpret.

| What the newer harness did | What you see in the older app |
| -------------------------- | ----------------------------- |
| Published a newer format file (`session.vN`) for a session | The session silently disappears from the session list |
| Wrote event types the bundled build does not know, at the same format version | The session stays listed, but opening it fails with a history-load error naming the unknown event type |
| Changed the shared profile composition | The app may fail to start before any session opens |

A reported case: a session written by `dsh ≥ 0.2.1-alpha.3` contains `job/registered` events that builds up to `0.2.1-alpha.2` do not know, both at format version 4. Opening that session on the older build fails with `contains event type "job/registered" ... unknown to this harness`.

<a id="what-you-can-do-today"></a>

## What you can do today

- Open the affected session with the newer tool. The data is intact; only the older build refuses it.
- Keep the CLI and the app's bundled Harness on matching versions, so neither writes data the other cannot read.
- Avoid running a newer CLI against the same sessions while the app is open — a concurrent foreign write can land inside a session the app is using.
- Manually moving `session.vN` files aside can expose the previous generation for format-version cases, but it is unsupported: it hides newer events rather than reconciling them, and it cannot help when pollution lives inside the shared current file.

<a id="rollback-path"></a>

## Rollback path

The app ships a checkpoint/restore mechanism: after each reported clean exit it snapshots session data that the bundled Harness verifiably reads, and after a newer harness writes incompatible data you can roll one session back to its last verified copy from the "Restore a Session…" menu or a startup prompt. See [Session Data Checkpoint and Restore](session-checkpoint-restore.md).
