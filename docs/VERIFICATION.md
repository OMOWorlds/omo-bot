# Verification record

Updated 2026-10-06. Pinned environment: Node 24.21.0, pnpm 10.34.5, PocketBase 0.40.4 and PostgreSQL 17.10.0. No production credentials or real Discord account were used.

## Persistent message snapshots and channel labels

The 2026-10-06 regressions reproduced lost deletion content after one hour, cache loss on a cosmetic settings change, and message embeds that identified a channel solely through a Discord-resolved mention. The fixes add a 5,000-message/24-hour memory and persistent cache, batched into workerPoll, plus captured channel names and explicit channel IDs.

`pnpm check` passed (78 unit tests and 87 integration tests at that point), as did production/fixture builds, PocketHost bundle generation and all 18 desktop/mobile browser tests. Follow-up paging, category/thread exclusions, old-hook refusal and the 1,000-message HTTP-budget cases passed with typecheck/lint and the affected suites (74 tests), bringing the suite totals to 80 unit and 89 integration cases. Desktop edit and mobile deletion preview screenshots were visually reviewed. The new budget fixture uses the actual adapter, collector, persistent-cache manager and worker cycle with simulated HTTP responses; it confirms 1,000 ordinary messages add no per-message storage requests. This is not a hosted load test.

Real PostgreSQL/PocketBase coverage includes restoration into a fresh collector, author/content preservation through edit/delete, snapshot removals, expiry, the persistent count limit, startup paging, malformed-batch rejection, policy pruning and disabled-write rejection. Unit coverage exercises retries and updates/deletions during an in-flight batch, Unicode request-size limits, restored snapshot expiry and preservation of newer live messages. PocketBase worker ownership also fences cache loads. Existing database migrations remain unchanged; the new hook and matching operations file must be installed before clients requiring messageCacheProtocol:1.

Production deployment, real Gateway resume/replay and live Discord permission/rendering checks were not performed. Initialization/downtime and unflushed changes remain coverage limits; a saved snapshot may predate an unseen edit.

## Foundation results

Typecheck, lint, production build and PocketHost bundle generation passed, along with 18 unit tests, 53 integration tests and eight desktop/mobile browser tests. The same foundation passed the GitHub Actions workflow on Linux before public-release preparation. Local browser screenshots were visually reviewed.

Integration tests start actual isolated PostgreSQL, PocketBase and SSH/SFTP processes. Coverage includes guild/module isolation, optimistic revisions, data expiry/restart, settings upgrades, job scheduling/dispatch, worker ownership, stale claim fencing, OAuth/session storage, protected routes, encrypted installation state, first-install provisioning and service supervision. Discord identity and sends are simulated.

Browser tests cover sign-in protection, routing settings, diagnostics, real queued fixture jobs, persistent module results, enable/disable behavior and setup. The example form preserves unsaved drafts during polling; mobile overflow checks use the visible viewport. Production and fixture builds are separate, and E2E builds both before launching services.

## Public-release verification

After adding Apache 2.0 licensing, dependency notices, generic community defaults and public documentation, the full checks passed again: typecheck, lint, production build, PocketHost bundle, 18 unit tests, 53 integration tests and eight desktop/mobile browser tests. License/notice files in the backend and both dashboard builds were compared byte-for-byte against their source files. Workspace manifests declare Apache-2.0. The release uses a clean root commit and GitHub noreply author metadata; the previous internal history is not part of the public repository. A targeted credential/path scan found no real credentials or local personal paths in the publication tree; test fixture values and third-party copyright attribution remain intentional. This is not a claim of a complete security audit.

## Reproduce

### Channel log formatting regression

The 2026-09-29 baseline passed typecheck, lint, 18 unit tests and the production build. Six new regression cases failed under the old renderer, reproducing raw snapshot output for create/delete, missing changed-field and permission rendering, missing-data behavior and noisy delivery-test output.

After the fix, typecheck, lint, 28 unit tests, 53 real database/integration tests and eight desktop/mobile browser tests passed. Final text/overflow refinements were checked again with typecheck, lint, 28 unit tests, production/fixture builds and the two routing-preview browser cases. Screenshots: `test-results/log-preview-desktop.png` and `test-results/log-preview-mobile.png` (local, ignored). The running dashboard previews readable channel metadata and overwrite counts with no raw Before/After JSON, empty reason or horizontal page overflow.

Regression coverage includes removed/added overwrites, Allowed/Denied/Inherited transitions, permission reordering, missing/invalid snapshots, cleared settings, meaningful optional settings, escaping and mention suppression, long payload limits, retained raw evidence, saved accent colors and the exact delivery marker suffix. Database/schema and delivery transport behavior were not changed. Existing Discord messages retain their old formatting. Actual Discord client rendering and the downstream hosted rollout remain unverified.

The first integration attempt was blocked by sandbox local-listener restrictions (`EPERM: listen EPERM: operation not permitted 127.0.0.1`) and was interrupted. Rerunning with local process/network permission passed all 53 tests.

An immediate browser rerun reproduced the existing demo shutdown issue from ROADMAP.md: the previous lease had not expired, failed startup left an orphaned local PocketBase child, and Playwright could not start its web server. The confirmed test child was stopped and the lease allowed to expire before retrying; the singleton protection was not bypassed.

### Message, member and voice logging

The 2026-09-30 baseline passed typecheck, lint, 28 unit tests and the production build. The completed update passed typecheck, lint, 52 unit tests, 61 actual database/integration tests and ten desktop/mobile browser tests. Production and fixture builds passed. The provider suite exercises both PostgreSQL and the unchanged PocketBase hook bundle.

Collector tests cover ordinary-message suppression, edits, attachment changes, single/bulk deletions, unavailable content, count/TTL bounds, policy/cache resets, excluded channels/categories, own-bot suppression, unrelated updates, nickname removal, role-set comparison, missing member baselines, voice moves and per-side exclusions. Renderer checks cover all nine events, mention suppression, escaping, long-field limits, bounded role lists and honest missing data. Settings tests prove version-1 upgrades retain prior values and keep the new switches off.

Provider tests additionally persist/filter/deliver each supported event, reject excluded or disabled observations, cancel already queued events when their channel becomes excluded, and migrate stored settings once on both databases. Browser tests save/reload switches, preview all six new events, filter their stored fixtures and inspect details. The initial new browser cases failed because an exact label selector included wrapped option text; explicit accessible names fixed it. The full ten-test rerun passed. No test servers were left intentionally running.

Local screenshots `test-results/activity-message.edited-desktop.png`, `test-results/activity-member.roles.updated-mobile.png` and `test-results/activity-voice.left-mobile.png` were visually reviewed. Additional per-event screenshots were captured during the suite. These show the running dashboard's synthetic preview, not a live Discord client. A real Gateway session with the new intents, live member fetching, Discord delivery and the downstream rollout remain unverified.

### Commands

Install the pinned toolchain and frozen dependencies. Run `pnpm pocketbase:install`, `pnpm exec playwright install chromium`, `pnpm check`, `pnpm pocketbase:bundle`, then `pnpm test:e2e`. Local listeners and child processes must be permitted. Do not rebuild frontend assets while tests are using them.

PocketBase startup tests intercept attempted browser commands and verify the committed headless hook suppresses installer tabs on startup/restart. A terminal process-group interruption can still prevent demo lease cleanup; wait for lease expiry and inspect orphaned children rather than repeatedly restarting or bypassing ownership checks.

## Limits

Passing tests do not establish exactly-once external delivery, full event-family coverage, live Discord/PocketHost permissions, hosted latency, container operation, TLS, load recovery or backup restoration. Version-aware upgrades of existing remote bundles, cross-provider transfers, installation-directory locking and durable setup-job recovery remain incomplete. See ROADMAP.md and SETUP.md.

## PocketHost request-budget release

Baseline before edits: typecheck, lint, 63 unit tests, 64 integration tests and production build passed. After implementation, typecheck, lint, 68 unit tests, 70 integration tests, production/fixture builds, 12 desktop/mobile browser tests and the PocketHost bundle pass. No live credentials or Discord sends were used for these checks.

The new request harness drives the actual PocketBase adapter, independent lease timer, ModuleHost, WorkerCycle, logging worker and Fastify/Auth with simulated time and HTTP responses. It counts every serialized request in that workload, including startup and shutdown. Results: 325 requests for one idle module, 328 for two, and 912 for two plus 100 changes and 60 authenticated workspace loads. The active workload peaks at 27 requests/10 seconds. This is not an actual hosted one-hour load test; independent real-provider tests establish queue, session and storage behavior.

Real PostgreSQL/PocketBase regressions cover combined module/heartbeat snapshots, due/delayed/expired jobs, no premature claiming, event/config preparation, stale claim tokens, settings disable during Discord validation, session touch without reviving expiry, protected workspace access and revoked membership. PocketBase ownership tests fence the new worker operations. Unit tests also cover old-hook refusal and late successful renewal arriving after the local deadline.

Browser tests verify a single shared workspace request on load, one request per accelerated minute for three minutes despite multiple mounted consumers, explicit refresh, and preservation of dirty logging drafts. Full fixture flows still pass for logging, modules and setup. Reviewed mobile screenshot: `test-results/workspace-budget-mobile.png`; desktop equivalent is also available locally. These are ignored artifacts.

Only operations.js needs replacement on the hosted instance; migrations are unchanged. Bundle manifest includes trafficProtocol 1 and file SHA-256 hashes. Comet reported the Mac locked, so live hook upload, client deployment and sustained hosted quota observation remain pending. Do not deploy current clients against old hooks.

## Declared module secrets

Baseline before edits: typecheck, lint, 68 unit tests, 70 integration tests and production build passed. The completed feature passes typecheck, lint, 68 unit tests, 80 integration tests, production/fixture builds, 16 desktop/mobile browser tests and PocketHost bundle generation. The first browser run had two navigation assertions read the old DOM before the React route transition finished; waiting for the destination heading corrected those assertions, and the complete suite passed afterward.

Ten new real-provider cases test ciphertext at rest; authenticated guild/module/name binding; unknown names; concurrent creation/replacement/deletion; monotonic tombstones; explicit environment restoration; missing/wrong encryption keys; corrupted ciphertext; per-job rotation/deletion behavior; and owner-only, fresh-membership/CSRF-protected endpoints. Metadata and job results are checked for absence of synthetic credentials. Managed-runtime tests verify encrypted-profile persistence and retry after a failed key save before starting children.

Desktop/mobile tests cover masked defaults with zero automatic reveal requests, cleared password inputs after saving, explicit Show/Hide, 30-second expiry, navigation clearing, ignored late responses after Hide/close, deletion/fallback controls and absence from browser persistence. Reviewed screenshot: `test-results/module-secret-mobile.png`; desktop equivalent is available locally. Tests use synthetic credentials only. No community API behavior or production deployment was included.

PocketBase requires the new module-secret migration and matching hooks; PostgreSQL requires migration 0004. Clients check secretsProtocol:1. Bot/web must receive the same dedicated MODULE_SECRET_ENCRYPTION_KEY. Changing that encryption key does not rewrap old ciphertext. The base budget's simulated idle/workload counts remain unchanged; interactive secret management and async reads add explicitly requested storage calls.

## Dashboard static-asset rate limits

Request GG-EVENTS-20261001-04: baseline typecheck, lint and 68 unit tests passed. The new real-server regression failed before the fix with HTTP 429 during an asset GET/HEAD burst. Afterward, typecheck, lint, production/fixture builds, 68 unit tests, 81 integration tests and all 18 desktop/mobile browser cases pass together.

The integration regression serves an actual temporary static file through Fastify, requests it 150 times by GET and 150 by HEAD, then verifies the full page 120, API read 360, API write 60 and auth 20 per-minute allowances. Each next request returns 429 with Retry-After and no-store. Asset-looking query parameters do not bypass protected routes; assets still load after the application buckets are exhausted. Missing assets return 404 and unsupported methods do not return file content.

Each browser project requests a built JavaScript asset 150 times, signs in and opens the dynamically loaded logging page without 429 or page errors. The full combined suite passes; the mobile screenshot test-results/asset-burst-mobile.png was visually reviewed. These are local synthetic checks, not a production rollout. Only matched GET/HEAD routes in the reserved /assets/ namespace are exempt; storage traffic and configuration are unchanged.
