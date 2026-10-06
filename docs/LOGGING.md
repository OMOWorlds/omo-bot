# Activity logging

The bundled logging module records channel creation, updates and deletion; message edits and deletion; member nickname changes; member role additions/removals; and voice channel joins/leaves. Moving between voice channels creates a leave and a join, each checked against its own exclusions. Mute/deafen changes do not create logs. Voice audio is never recorded.

New messages do not create database events or Discord logs. Bulk deletion creates one event per deleted message. Embed-only, pin and reaction updates do not count as message edits. Role logging concerns roles assigned to members, not creation or deletion of server roles. Audit attribution is unfinished: the member or message author is the subject, not proof of who changed or deleted it.

## Enable or upgrade

1. In the Discord Developer Portal, open the application's Bot settings and enable **Server Members Intent** and **Message Content Intent**. The installed logging module requests these even when its switches are off. Discord may require approval for privileged intents on verified applications. See [Gateway intents](https://docs.discord.com/developers/events/gateway#gateway-intents).
2. For the persistent message-cache update, deploy the updated PocketBase `pb_hooks/operations.js` and new `pb_hooks/message-cache.js` first; readiness must advertise `messageCacheProtocol: 1`. Then stop the old bot worker and deploy matching bot/dashboard builds. Keep one bot worker per guild. The cache uses the existing module-record table, so no new database schema migration is required. See [PocketHost rollout](POCKETHOST.md#persistent-message-cache-update).
3. Existing logging settings automatically upgrade from version 1 to 2, preserving destinations, exclusions, retention, accent and channel switches. The six new event switches start **off** on existing installations. Fresh installations have all switches selected, with the module itself disabled until configured and enabled.
4. In **Activity logging > Routing**, select the desired events, choose a private text destination and save. Enable the module from Modules if needed and wait for its applied revision to match. Use Preview log to inspect synthetic examples without sending them.
5. Use Diagnostics to send a delivery test, then check a test channel with a message edit/deletion, nickname change, role assignment/removal and voice join/leave. These live Discord acceptance checks remain necessary after deployment.

The bot needs access to observed channels and View Channel, Send Messages, Embed Links and Read Message History in the logging destination. Guild Messages and Guild Voice States are requested automatically alongside Guilds. No permission to read an audit log is evidence of confirmed attribution in this version.

## Message content and retention

While message logging is active, the collector keeps at most 5,000 recent messages in memory for up to 24 hours after their latest observed create/edit. A persistent cache in the selected database has the same count and expiry bounds and restores snapshots after restarts. The SDK's separate message cache is disabled. Excluded channels/categories, the log destination, other guilds and DMs do not populate the comparison cache. Known messages authored by this bot retain only enough metadata to suppress their logs.

Changed snapshots and removals are batched into the existing worker poll, normally every 30 seconds on PocketHost or two seconds elsewhere, with up to 100 snapshots and 512 KiB per poll. Busy bursts can take several polls. Clean shutdown flushes pending batches; a crash or storage failure can lose unflushed changes. Startup reads snapshots in pages of 500, adding up to ten storage requests for a full cache. Ordinary message traffic adds no separate recurring storage requests. Snapshots expire from their observation time, not their restore/flush time; expired records are unreadable and removed during cleanup. Resumable Gateway reconnects preserve the cache and process replayed events. Activity missed during an unresumable disconnect or downtime cannot be reconstructed, so a restored snapshot may predate an unseen edit.

Snapshots keep at most 4,000 content characters and ten attachment IDs/names. Files are not downloaded and attachment URLs are not stored. Ordinary new messages persist only a temporary snapshot, without a log event or Discord post. An edit or deletion creates a separate message observation. That event uses the configured retention period, 7 to 90 days, default 30. Shortening event retention also shortens existing event deadlines. Database expiry does not delete log posts already delivered to Discord.

Discord deletion packets contain IDs rather than deleted content. Messages never observed by the bot, expired/evicted snapshots and unflushed changes can therefore still produce logs with unavailable content or authors. Existing missing content cannot be recovered retroactively. The collector never invents missing text or fetches deleted messages. See [Gateway events](https://docs.discord.com/developers/events/gateway-events). Rendered Discord fields abbreviate long content; bounded captured snapshots remain in dashboard details.

Message logs include a captured channel name and explicit channel ID alongside the clickable mention. A Discord client displaying that mention as “No Access” does not establish that the bot lacked access when it observed the message. The name/ID remains useful when a viewer cannot resolve the mention or the channel is later deleted. Older stored events without a captured name still show the channel ID. This change does not grant channel access or rewrite existing Discord log posts.

Member comparison uses Discord's cached member baseline, loaded at startup. If no baseline exists, the bot records a coverage gap instead of claiming a nickname or role changed. Activity during initialization, downtime or queue overflow cannot be reconstructed. Check Diagnostics for recorded gaps; absence of a gap does not guarantee complete coverage.

Member join and leave alerts are not implemented yet. Roles assigned after an observed join can produce role-change logs. Roles already present in the initial member snapshot are a baseline, not evidence of a subsequent assignment, and are not reported as changes.

## Exclusions and queued delivery

Channel/category exclusions apply before capture and again before delivery. Message threads also honor exclusions on their parent channel and category when that scope is known. Voice moves are evaluated per channel. Member nickname/role events are guild-wide and have no channel scope.

Disabling an event type cancels its unsent deliveries when processed. Disabling Logging or both message event types clears message snapshots; newly excluded snapshots are also removed. Unrelated changes such as log color preserve eligible snapshots. Already stored event observations stay until their retention deadline. Excluding the log destination from message collection also prevents feedback from logging its own edits/deletions. Durable retries use the existing delivery marker; external delivery is not guaranteed exactly once.
