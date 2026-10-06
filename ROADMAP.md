# Remaining implementation and deployment

Updated 2026-10-01. Unchecked requirements are unfinished work. The verified first slice is described in [HANDOFF.md](HANDOFF.md).

## Setup follow-through

- [ ] Verify the working SFTP installer against the a real PocketHost instance and real Discord activation. Local complete provisioning and child-process lifecycle tests pass.
- [ ] Add PocketHost account connection to create/register deployment keys, select/create instances and restart through verified provider APIs. Today users supply a registered key; automatic hook reload is tested locally.
- [ ] Add version-aware bundle upgrades. The initial wizard intentionally refuses to overwrite differing existing hooks/migrations; identical uploads are retryable.
- [ ] Add provider-to-provider export/import with queue and session semantics. Switching profiles currently selects the target database's data and keeps the old database intact.
- [ ] Add installation-directory process locking and durable setup-job recovery. Run one managed launcher per installation directory; interrupted jobs currently retry from persisted profiles and generated keys.

## Development tooling follow-up

- The demo restart/lease issue below was reproduced again during the 2026-09-29 channel-formatting preview rerun. A successful full browser suite followed by an immediate second run failed before tests with the same worker-lock error and left a PocketBase test child on port 8092. This remains separate from the logging renderer fix.
- [ ] Harden demo shutdown/restart after a terminal process-group interruption. During the theme review, two restarts of `.local/demo-pocketbase` failed at `scripts/demo.ts:21` with `Another bot worker already holds this guild lock.` after the previous demo was stopped. Process inspection found no remaining demo/PocketBase process. An isolated `.local/theme-preview` database started normally. The module verification also reproduced a startup failure leaving an orphaned PocketBase child on port 8092; stopping that confirmed test child and allowing lease expiry restored startup. Reproduce signal ordering, failed-start cleanup and lease expiry before changing the ownership logic; do not bypass the worker lock.

## Module credentials

- [x] Implement generic declared-module encrypted storage, owner editor/reveal controls and async next-job lookup on both providers. See docs/MODULE_SECRETS.md.
- [ ] Complete the separately authorized downstream rollout after schema/hook upgrades and matching bot/web encryption keys. Current request explicitly excludes production deployment.
- [ ] Add encryption-key rewrap/rotation tooling with verified recovery. Replacing an API credential is supported now; changing the server encryption key does not migrate existing ciphertext.

## Next implementation slices

- [x] Add bounded persistent message snapshots for restart recovery and readable channel name/ID fallbacks for message logs. Both database providers, batched request budgets and local browser previews are verified; live Gateway/Discord acceptance remains outstanding.
- [x] Fix activity collector settings across installed module factories. Real provider regressions reproduced applied logging with zero captured deletion/role/voice events because runtime and module had separate repositories. Collection now reads the running host's accepted settings; production-registry capture, delivery and disable tests pass on both databases. Live Discord verification remains outstanding.
- [x] Replace raw channel snapshot dumps in Discord with compact create/delete summaries and changed-field updates. Permission overwrites use counts or readable state transitions; detailed evidence remains in the dashboard. Regression fixtures reproduce large overwrite arrays seen in production screenshots. Local verification is recorded in docs/VERIFICATION.md; live Discord rendering still needs checking after downstream deployment.
- [x] Add message edits/deletions (including bulk deletion), member nicknames, member role assignments/removals and voice joins/leaves. Ordinary new messages create no log records. Bounded-cache, missing-baseline, exclusion and dashboard coverage is verified locally; live Discord acceptance remains below.
- [ ] Add the remaining event families: member joins/leaves, server role creation/update/deletion, thread lifecycle and moderation. Add real Gateway reconnect/replay and ordering acceptance checks; current collector fixtures exercise cache resets and partial updates.
- [ ] Implement confirmed audit-log attribution and moderation correlation. Current records honestly show unknown attribution; no actor is inferred from proximity alone.
- [ ] Finish durable batching/digests and burst recovery. Current delivery claims and retry/nonce reconciliation pass local tests; this is not evidence for the full batching acceptance gate.
- [x] Implement the reusable module foundation: namespaced records on both providers, module-dispatched delayed jobs, command/intent declarations, sequential settings upgrades, dependency/execution guards, and package scaffolding/selection. See docs/MODULES.md. The original full bot acceptance gate still requires live verification and remaining logging coverage.
- [ ] Verify all routing changes against already leased work, including crash/restart during a destination change. Existing tests cover claim fencing, expiry, exclusions and recovery but do not establish every in-flight route-change interleaving.
- [ ] Expand dashboard acceptance to future event families, attribution states, access roles and degraded-state workflows. Current desktop/mobile coverage includes switches, previews and filters for message, nickname, member role and voice events.

## Deployment acceptance

- [x] Implement and measure batched worker maintenance, delivery preparation and shared dashboard snapshots on both providers. Local HTTP tests count 325/328 requests for one/two idle modules and 912 for two modules plus 100 changes and one open overview. See docs/POCKETHOST.md for the exact workload and limits.
- [ ] Deploy request-budget hooks before clients and verify live quota use for a full hour. This requires `ready.trafficProtocol === 1`. Comet access was blocked by the locked Mac; current local tests do not prove live throughput. Larger bursts, more viewers and additional module operations still need a supported higher host budget or self-hosted storage.
- [ ] Verify a dedicated Discord test application/guild end to end: OAuth, command registration, membership changes, permissions, Gateway events and delivery. Configure credentials privately.
- [ ] Upload the PocketHost bundle, configure Secrets, confirm selected PocketBase version and migration startup. Official host capabilities are verified; this account's execution is not.
- [ ] Build/run the production container images and verify TLS, health probes, restart and graceful shutdown on the selected Node host. Compose manifests parse; container deployment has not run.
- [ ] Run realistic event bursts, network delays/outages, lease loss during an in-flight Discord send, long reconnect gaps and sustained observation. Local transactional correctness does not establish host throughput or loss-free Gateway recovery.
- [ ] Configure protected off-host backups and monitoring; prove restoration into a fresh instance without blindly replaying already delivered work. Current restart tests prove persistence, not backup restoration.
- [x] Verify the foundation in hosted CI: typecheck, lint, builds, 18 unit, 53 integration and eight browser tests.

## Community modules

- [ ] Add a documented event API integration example once an API contract is confirmed. Support browsing and updates first, then staff drafts with explicit confirmation before publishing. Server-specific production integrations belong in their own downstream repositories.

## Explicitly deferred

- Standalone SQLite provider. PocketBase already uses SQLite internally; a direct adapter is not yet implemented.
- Automatic provider switching and cross-provider export/import. Selecting `STORAGE_PROVIDER` does not transfer data.
- Multi-guild service hosting. Each deployment is bound to one configured guild.
