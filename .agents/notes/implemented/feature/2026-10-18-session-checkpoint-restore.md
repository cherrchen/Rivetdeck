# Agent Note: Desktop session checkpoint and journaled restore

Status: implemented

English | [中文](2026-10-18-session-checkpoint-restore.zh.md)

## Problem

Rivetdeck and CLI `dsh --profile web` share one `$DSH_HOME`, so a newer CLI can write session data the bundled Harness cannot read. One failure mode publishes a higher-generation file and leaves the predecessor intact; the other — the reported incident, dsh-plugin-git PR #20's `job/registered` at seq 24 inside `session.v4.jsonl.zstd` — pollutes the shared current-generation file in place and leaves no untouched copy to expose. For the second mode the only remedy was opening the data on a newer host.

## Decision

Desktop stages a checkpoint candidate after each reported clean Host drain and commits it only for sessions that pass the bundled Harness's real read path inside a read-only worker child. A session whose new copy fails validation keeps its previous verified copy carried into the candidate; a candidate mixing capture times re-validates the combined related-source closure before commit. Per-session restore is a journaled transaction under the session's own `session.lock` write lease: live files are fingerprinted and moved to quarantine, checkpoint bytes publish under canonical names, and a leftover journal converges before the next Host spawn — deferring with a startup dialog while a foreign writer holds a member lease, and stopping as conflicted when live files drifted during the interruption. Three entries reach restore: startup drift detection confirmed through the same read-only validation, an open-time `SessionFormatUnsupportedError` prompt, and a manual menu item.

The mechanism contract lives in [docs/electron/session-checkpoint-restore.md](../../../../docs/electron/session-checkpoint-restore.md). The covered set is sessions plus the managed profile file set, the home-root patch, `session_projcache` storages, and `.env`; credentials, identity, attachments, `node_modules`, and transient lock files are excluded. Restore granularity is per session with its related-source closure; profile rollback is a separate transaction and stays out of scope. Retention bounds only total space — every session's last verified copy is protected. Files from a killed or unverifiable run never promote.

## Alternatives considered

**Desktop-private sessions root.** One overlay line makes Desktop immune to skew but Desktop and CLI stop sharing session history, which defeats the shared-home premise.

**Startup sweep hiding future-generation files.** Covers only the newer-file mode; in-place pollution lives inside the shared current-generation file and a sweep would silently truncate visible history.

**Sanitize-fork: decode, drop unknown events, write a new session copy.** Dropped events can leave dangling references and need seq renumbering, so it offers no safety guarantee. It remains a possible recovery tool, not the main path.

**Keep the bundled Harness version-aligned with the CLI.** An operational practice rather than a mechanism; skew recurs whenever the CLI moves first.

**Do nothing.** Matches the upstream conclusion but leaves the incident's only remedy as "open on a newer host" for the in-place-pollution mode, where no pre-image exists.

## Consequences

Restore rolls back; it does not merge. A checkpoint must exist before the pollution — already-affected sessions have no pre-image. Per-session validation is the load-bearing gate; stat-diff is only a scan hint and flags compatible foreign writes too. A crash or force-quit promotes nothing, so a restore can drop a whole run's session growth. The write lease protects only writers that honor it, so restore additionally requires the confirmed no-other-Harness precondition across switch and finalize; an undetectable foreign reader's in-flight `coldSnapshot` write-back can still re-poison `session_projcache`, a documented non-guarantee. CLI-only users hitting the same skew have no recourse here.

## Testing

`apps/electron/tests/checkpoint-acceptance.spec.ts` pins the fault-injection and real-backend cases: carry-forward across two polluted exits, real `session.lock` competition, read-open at every switch stage, interruption resume at each phase, unknown-event and newer-generation restores, and branch preservation through a quarantine swap-back. `checkpoint-restore.spec.ts` covers the journal state machine and refusals; `checkpoint.spec.ts` covers capture, promotion gating, and the validation worker's result framing; `checkpoint-detect.spec.ts` covers drift detection and the honest no-checkpoint refusal.

## Deferred

- Whether a separately confirmed quarantine feature is wanted for sessions with no verified copy; v1 refuses and leaves live data in place.
- Whether the first launch after a restore may immediately run scheduled or background tasks against restored state.
- Cache coherence beyond the precondition: a `CheckpointIdentity` epoch or equivalent upstream change would let stale `session_projcache` write-backs be rejected instead of relying on process absence.
- Profile and dependency restore, including rebuild honoring `pnpm-lock.yaml` and the install-failure fallback; v1 backs up the managed file set without claiming coverage.
