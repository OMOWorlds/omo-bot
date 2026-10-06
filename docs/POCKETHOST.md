# PocketHost deployment guide

Last checked: 2026-10-06. Locally tested PocketBase version: **0.40.4**. Current clients require storage capabilities **trafficProtocol: 1**, **secretsProtocol: 1**, and **messageCacheProtocol: 1** alongside storage protocol **1**.

PocketHost documents SFTP access to `pb_hooks` and `pb_migrations` and Secrets exposed in the PocketBase runtime. These capabilities support this adapter on a normal hosted instance without a custom binary. Account-specific deployment has not been performed.

Primary sources: [PocketHost SFTP](https://pockethost.io/docs/ftp), [Secrets](https://pockethost.io/docs/secrets), [phio CLI](https://pockethost.io/docs/phio), [PocketBase transactional migrations](https://pocketbase.io/docs/js-migrations/).

## Browser setup

The new managed launcher can upload and bind a fresh instance from the browser. Follow [SETUP.md](SETUP.md). It uses SFTP deployment credentials plus a temporary PocketBase superadmin login, and stores the generated runtime binding in a private table. The environment/Secrets procedure below remains available for separately managed bot/web services.

## One instance per Discord guild

Create/select a dedicated PocketHost instance for each bot deployment. Use its HTTPS origin, preferably the permanent UUID hostname to survive display-name changes. The custom routes reject guild IDs other than the instance's configured guild. Do not repurpose an instance for another guild by changing its ID after data exists; create a fresh instance instead.

PocketHost stores data; the Discord Gateway connection and Fastify dashboard run as separate Node services on your host. This guide does not assume PocketHost can run an arbitrary persistent Node process.

## Prepare the instance

1. Select PocketBase 0.40.4, or verify any other host-provided version against this repository's contract tests before deployment. Avoid untested version jumps.
2. Generate a random 32-byte hexadecimal storage key in a private terminal/password manager. Generate a separate 32-byte hexadecimal session encryption key. Do not use the example placeholders or put either key in source control.
3. Add these values through the instance's **Secrets** interface:
   - `OMO_STORAGE_KEY`: the storage key (64 hex characters).
   - `OMO_GUILD_ID`: the exact Discord guild snowflake.
4. Run `pnpm pocketbase:bundle`. It creates `dist/pockethost/pb_hooks`, `dist/pockethost/pb_migrations`, and a checksum manifest.
5. Upload the **contents** of those two directories into the instance's corresponding directories via SFTP or phio. Keep the layout flat: `pb_hooks/000_omo_headless.pb.js`, `pb_hooks/omo.pb.js`, `pb_hooks/operations.js`, `pb_hooks/message-cache.js`, `pb_hooks/installation.js`, `pb_migrations/1790265600_omo_storage.js`, `pb_migrations/1790265601_instance_binding.js`, `pb_migrations/1790265602_module_resources.js`, and `pb_migrations/1790851200_module_secrets.js`. Do not upload `.env`, `.local`, `node_modules`, or any local `pb_data`.
6. Restart the instance using PocketHost controls so committed migrations execute. Their initial rollback intentionally refuses automatic table deletion; restore a verified backup for a destructive rollback.

PocketHost's documented SFTP settings are host `ftp.pockethost.io`, port `2222`, username your account email, and an Ed25519 key registered under Account → Keys. Scope the key to the target instance. The service provides SFTP, not a remote shell. Use the current PocketHost docs for connection details and key verification.

The `omo_` tables are intentionally private SQL tables, not public PocketBase collections. They are part of the normal PocketBase data database and backups. Our dedicated staff dashboard is their application interface; no collection API rule can accidentally expose captured logs. A future operator-facing collection view can be added deliberately.

## Configure the bot and web services

Set these in each service's private environment:

```dotenv
STORAGE_PROVIDER=pocketbase
POCKETBASE_URL=https://YOUR_INSTANCE.pockethost.io
POCKETBASE_SERVICE_KEY=THE_SAME_VALUE_AS_OMO_STORAGE_KEY
DISCORD_GUILD_ID=THE_SAME_VALUE_AS_OMO_GUILD_ID
```

Also configure the Discord/application/owner/dashboard values in `.env.example`. PostgreSQL connection variables are unnecessary in this mode. `pnpm db:migrate` verifies the PocketBase schema; it does not upload migrations or remotely restart your instance.

Use `pnpm build` for production. A PocketHost-oriented Compose template is available:

```sh
docker compose --env-file .env -f infra/compose.pockethost.yaml build
docker compose --env-file .env -f infra/compose.pockethost.yaml up -d
```

Set `DASHBOARD_DOMAIN` for Caddy and use the same HTTPS origin in Discord's callback registration. The Compose file supplies only bot credentials to bot and only OAuth/session credentials to web. Both get the storage key. No PocketBase superuser password/token is needed by the runtime.

These commands are deployment instructions, not evidence that an image or your hosted instance has been deployed/tested here.

## Reliability and upgrade rules

- Each event and its initial delivery row commit in one PocketBase transaction. A failed queue insert rolls back the event.
- Settings updates compare revisions inside a transaction. A stale editor gets 409 and retains its unsaved changes.
- One bot owns a renewable 60-second instance lease. It renews every 20 seconds and fails closed on renewal failure; server-side writes verify the owner. Delivery/job claims have separate tokens and 90-second leases so an old worker cannot finalize a newer claim.
- Verify worker ownership immediately before sending. Discord posting remains at-least-once/best-effort duplicate suppression: no database can atomically commit a Discord HTTP send and a local transaction.
- Requests have bounded timeouts and never silently switch backend. Storage outages can lose uncommitted Gateway observations; coverage incidents must remain visible.
- Back up before uploads that change migrations. PocketBase migrations run transactionally. Keep the matching hooks, migration files and previous application image together for rollback analysis.
- Use PocketHost's supported backup mechanism and download/retain protected copies separately. Test a restore into a fresh instance, run cleanup, inspect representative event/settings/queue rows, and start only one worker. Do not blindly replay old delivered queues.
- Checkpoint/migration imports between PostgreSQL and PocketBase are not implemented. Keep a deployment on its selected provider until an explicit export/import tool is tested.

## Not yet verified on your account

Instance version selection, Secrets propagation, SFTP upload/restart, latency/rate limits under realistic bursts, backup restoration, real Discord login/delivery, and sustained production observation remain deployment checks. The local test suite establishes backend semantics, not PocketHost account configuration or Discord permissions.

## Request budget and operational limits

[PocketHost's published limits](https://pockethost.io/docs/limits) include 1,000 requests/hour per source IP, 10,000/hour per instance and 50 requests per 10 seconds per IP. A backend bot and dashboard can share the same outbound IP. Unlimited instances do not imply unlimited requests. Use the returned `X-PocketHost-RateLimit-Ip-Hourly-*` and instance headers for the actual allowance. Rate-limit headers are edge-local observations, not a guarantee of a global remaining budget.

The worker uses one `workerPoll` every 30 seconds on `*.pockethost.io`: all installed module states, heartbeat and due-work availability. It does not claim jobs or deliveries until after settings synchronization. Catalog refresh is every five minutes; core/logging cleanup is hourly. Independent lease renewal is every 20 seconds; the remote lease remains 60 seconds and the local monotonic deadline remains 45 seconds. A late or failed renewal still stops ownership.

Log delivery uses `deliveryPrepare` to claim and read its event/settings, followed by `deliveryVerify` immediately before Discord posting and `deliveryFinish`. Capture plus a normal successful delivery costs four HTTP requests. There is no empty-queue claim on idle polls. Disabled, expired and excluded deliveries are still checked; saved configuration changes or stale claim tokens prevent a send. Discord delivery remains at-least-once with existing marker reconciliation.

The dashboard shares one authenticated workspace snapshot per minute across overview, navigation, module controls and logging settings/diagnostics. Session reads also touch valid sessions in one operation. Membership checks still occur at least every 60 seconds on reads and on every mutation. The detailed event list loads on navigation/filter changes and explicit refresh. Background tabs do not poll. Job diagnostics and third-party module pages can add traffic.

Measured in `tests/pockethost-budget.test.ts` through the production adapter, worker cycle, logging delivery and Fastify/Auth, using simulated time and HTTP responses:

- One module, idle hour including startup/shutdown: **326 requests**.
- Two installed modules, idle hour including startup/shutdown: **329 requests**. Recurring cost stays the same; startup has three more requests.
- Two modules, 100 separately captured/delivered changes spread across 50 minutes, one overview open for the full hour: **913 requests**, peak **28 in a rolling 10-second window**.

These are measured test workloads, not live PocketHost capacity certification. They include 180 lease renewals, 120 polls, 12 maintenance catalog refreshes plus startup, one core/logging cleanup each, dashboard authorization and 59 membership refresh writes. Failures, retries, interactive navigation, explicit refreshes, external health monitors, more viewers, generic module records/jobs and bursts add requests. An hourly average does not protect against a burst cap. Ordinary new chat messages are saved as temporary snapshots in existing worker polls; they do not create event-storage requests. These totals include one startup read for an empty persistent cache; a full cache adds up to nine more reads.

For busier servers, use PocketHost's supported trusted-IP option or request a larger operator-configured budget, or self-host PocketBase near the bot. Trusted IPs need a stable egress address and account configuration; do not spoof client-IP headers or rotate addresses to evade limits. PostgreSQL remains supported. No automatic data migration or provider fallback occurs.

## Upgrading existing instances for the request-budget release

This update changes **only `pb_hooks/operations.js`** on the PocketBase side. It does not change the schema, migrations, binding, service key or stored data. The updated hooks remain compatible with the previous bot/dashboard, allowing a hooks-first rollout. New clients refuse to initialize if `ready` does not return `{ "protocol": 1, "trafficProtocol": 1 }`; do not deploy those clients first.

1. Retain a verified PocketHost backup and the current bot/dashboard image. Generate the bundle with `pnpm pocketbase:bundle`; inspect `dist/pockethost/manifest.json` for the expected SHA-256.
2. Confirm the target instance and registered instance-scoped SFTP key. The previous unmodified `operations.js` from base commit `1796e3a` has SHA-256 `62693fa1182e75c1b528769d577816d7b6821eed017e8cc97c413910d84fa30d`. If the remote file differs, review its customizations before replacing it.
3. Through PocketHost controls, stop the instance for a brief maintenance window, replace only `pb_hooks/operations.js` from the bundle using SFTP, then start it. Alternatively, a verified atomic replacement with supported hook reload avoids a partial-file window. Do not truncate a live hook file in place. The initial setup wizard intentionally refuses differing files; it is not an upgrade tool.
4. From the deployment environment, POST `/api/omo/v1/ready` using its existing `X-OMO-Storage-Key` header and `{ "guildId": "CONFIGURED_GUILD", "input": {} }`. Confirm both protocol fields. Keep credentials out of terminal output and chat. Check normal operations and existing data as well.
5. Deploy the matching bot/dashboard revision. Check readiness, enabled/applied settings, a real edit/delete and role-change log, and the host's remaining quota over a full hour. The catalog can now take five minutes to reflect new channels; settings/delivery can take approximately 30 seconds plus processing.

If the client deploy fails, the previous client can run against the upgraded hooks. Restore old hooks only if rolling all clients back too; current clients require the new operations. Remote rollout and sustained live acceptance remain unverified until operator access is available.

## Additional upgrade for dashboard-managed secrets

The module-secret release adds `pb_migrations/1790851200_module_secrets.js` and changes `pb_hooks/operations.js` again. The hook-only steps above describe the earlier request-budget commit 49650dc, not this later release. Upload the new migration and matching hooks, apply/restart, and verify `ready.secretsProtocol === 1` before deploying secret-capable clients. Existing schema, bindings and data are retained. Configure the same separate `MODULE_SECRET_ENCRYPTION_KEY` on bot/web; never put it in the database or give it to the browser. See [MODULE_SECRETS.md](MODULE_SECRETS.md). Production rollout has not been performed.


## Persistent message cache update

The 2026-10-06 update adds `pb_hooks/message-cache.js` and updates `pb_hooks/operations.js`. Generate the bundle with `pnpm pocketbase:bundle` and install both matching hooks before deploying the new bot/dashboard. Use the existing maintenance/atomic-replacement workflow; the first-install wizard is not an upgrade tool. Readiness must advertise `messageCacheProtocol: 1` as well as the existing capabilities. No new migration, service key, or encryption key is required; snapshots use the existing guild-scoped module-record table. Old clients remain compatible with the updated hooks.

The cache stores up to 5,000 message snapshots for 24 hours. Writes ride on workerPoll, up to 100 snapshots/512 KiB per poll; they add no separate recurring HTTP requests. Startup restores pages of 500 (up to ten requests), and graceful shutdown may send extra polls to flush pending batches. Bursts can create a multi-poll backlog; crashes can lose unflushed updates. The normal 30-second PocketHost poll interval remains. This is bounded recent-message coverage, not an archive or recovery of messages the bot never observed. See [logging retention](LOGGING.md#message-content-and-retention).
