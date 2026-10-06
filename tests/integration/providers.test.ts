import { z } from 'zod';
import { exampleDefinition } from '../../modules/example/definition.js';
import { exampleModule } from '../../modules/example/bot.js';
import { ModuleHost } from '../../packages/core/src/host.js';
import { runModuleJobs } from '../../packages/core/src/jobs.js';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { localPocketBase } from '../../scripts/local-pocketbase.js';
import { localPostgres } from '../../scripts/local-postgres.js';
import { Database } from '../../packages/db/src/index.js';
import { PocketBaseAdapter } from '../../packages/db/src/pocketbase.js';
import { migrate } from '../../packages/db/src/migrate.js';
import type { StorageDriver } from '../../packages/db/src/contracts.js';
import { loggingDefinition } from '../../modules/logging/manifest.js';
import { LoggingRepository } from '../../modules/logging/bot/repository.js';
import { defaultLoggingSettings, eventTypes, eventLabels, type LoggingSettings } from '../../modules/logging/shared/settings.js';
import { previewEvent } from '../../modules/logging/bot/preview.js';
import { DeliveryWorker } from '../../modules/logging/bot/delivery.js';
import { botRegistry } from '../../registry/bot.js';
import { ActivityCollector } from '../../modules/logging/bot/collect.js';
import { PersistentMessageCache } from '../../modules/logging/bot/message-cache.js';
import { MESSAGE_CACHE_PREFIX, MESSAGE_CACHE_TTL, type MessageCacheEntry, type MessageCacheBatch } from '../../modules/logging/shared/message-cache.js';
import type { GatewayDispatchPayload } from 'discord.js';
import { createServer } from '../../apps/web/src/server.js';
import { readConfig } from '../../packages/core/src/config.js';
import type { Observation } from '../../packages/module-sdk/src/server.js';
const guild = '100000000000000001', owner = '100000000000000002', destination = '100000000000000010';
const settings = { ...defaultLoggingSettings, destinationId: destination };
const event = (sourceKey: string = randomUUID()): Observation => ({ guildId: guild, sourceKey, type: 'channel.created', subjectId: '100000000000000030', channelId: '100000000000000030', parentId: null, label: 'test-channel', observedAt: new Date().toISOString(), before: null, after: { name: 'test-channel' } });

describe.each(['postgres', 'pocketbase'] as const)('%s storage contract', provider => {
  let pg: Awaited<ReturnType<typeof localPostgres>> | undefined, pb: Awaited<ReturnType<typeof localPocketBase>> | undefined;
  let driver: StorageDriver, release: (() => Promise<void>) | undefined;
  beforeAll(async () => { if (provider === 'postgres') pg = await localPostgres(); });
  afterAll(async () => { await pg?.stop(); });
  beforeEach(async () => {
    if (provider === 'postgres') { const db = new Database(pg!.url); await migrate(db); await db.query('TRUNCATE guild_config,dashboard_session,oauth_state,worker_lease CASCADE'); driver = db; }
    else { pb = await localPocketBase(); driver = pb.driver; }
    await driver.scope(guild).initialize('Test community', [loggingDefinition]);
    release = await driver.singleton(guild, () => {});
  });
  afterEach(async () => { await release?.(); release = undefined; await driver?.close(); await pb?.stop(); pb = undefined; });
  const store = () => driver.scope(guild);
  const repository = () => new LoggingRepository(store());
  async function activate() { const state = await store().updateModule('logging', 1, owner, { enabled: true, settings }); await store().acknowledge('logging', state); }
  const cachedEntry = (id = '100000000000000099'): MessageCacheEntry => ({ id, channelId: '100000000000000031', parentId: null, containerId: null, savedAt: Date.now(),
    snapshot: { authorId: owner, authorName: 'Member', content: 'Saved before restart', contentTruncated: false, attachments: [], attachmentsTruncated: false } });
  const syncCache = (messageCache: MessageCacheBatch) => store().call('workerPoll', { moduleIds: ['logging'], jobModuleIds: [], status: 'online', details: {}, messageCache });
  const cacheRecords = () => store().call('recordList', { moduleId: 'logging', prefix: MESSAGE_CACHE_PREFIX, cursor: '', limit: 100 });
  it('restores a fresh collector from durable snapshots and removes deleted snapshots on the next poll', async () => {
    await activate(); const entry = cachedEntry();
    await syncCache({ upserts: [entry], deletes: [] });
    const observations: Observation[] = [];
    const collector = new ActivityCollector({ guildId: guild, botId: () => destination, settings: () => settings,
      channel: () => ({ parentId: null, containerId: null, name: 'general-chat' }), member: () => null, voiceChannel: () => null,
      emit: event => observations.push(event), missingMemberBaseline() {}
    });
    const cache = new PersistentMessageCache(store(), collector); await cache.restore();
    expect(cache.prepare()).toBeUndefined();
    const dispatch = (t: string, data: Record<string, unknown>) => collector.handle({ op: 0, t, s: 1, d: { guild_id: guild, channel_id: entry.channelId, id: entry.id, ...data } } as GatewayDispatchPayload, t);
    dispatch('MESSAGE_UPDATE', { content: 'Edited after restart' });
    expect(observations[0]?.before?.content).toBe('Saved before restart');
    const batch = cache.prepare()!; await syncCache(batch); cache.acknowledge(batch);
    expect((await cacheRecords()).records[0]?.value).toMatchObject({ snapshot: { content: 'Edited after restart' } });
    dispatch('MESSAGE_DELETE', {});
    expect(observations[1]?.before).toMatchObject({ authorId: owner, content: 'Edited after restart', channelName: 'general-chat' });
    await syncCache(cache.prepare()!); expect((await cacheRecords()).records).toHaveLength(0);
    expect((await repository().list({ limit: 10 })).events).toHaveLength(0); // Snapshot writes are not log events.
  });
  it('expires snapshots, rejects malformed batches, and cannot resurrect excluded or disabled content', async () => {
    await activate(); const entry = cachedEntry();
    await syncCache({ upserts: [entry, { ...entry, id: '100000000000000098', savedAt: Date.now() - MESSAGE_CACHE_TTL }], deletes: [] });
    expect((await cacheRecords()).records).toHaveLength(1);
    await expect(syncCache({ upserts: [entry, entry], deletes: [] })).rejects.toThrow();
    await expect(syncCache({ upserts: [{ ...entry, snapshot: { ...entry.snapshot, content: 'x'.repeat(4001) } }], deletes: [] })).rejects.toThrow();
    await repository().apply({ ...settings, accentColor: '#ffffff' });
    expect((await cacheRecords()).records).toHaveLength(1);
    const excluded = { ...settings, excludedChannelIds: [entry.channelId] };
    await repository().apply(excluded);
    const state = await store().updateModule('logging', 2, owner, { settings: excluded }); await store().acknowledge('logging', state);
    await syncCache({ upserts: [entry], deletes: [] }); expect((await cacheRecords()).records).toHaveLength(0);
    const enabled = await store().updateModule('logging', 3, owner, { settings }); await store().acknowledge('logging', enabled);
    await syncCache({ upserts: [entry], deletes: [] });
    await repository().cancelPending(); expect((await cacheRecords()).records).toHaveLength(0);
    await store().updateModule('logging', 4, owner, { enabled: false });
    await syncCache({ upserts: [entry], deletes: [] }); expect((await cacheRecords()).records).toHaveLength(0);
  });
  it('enforces the persistent snapshot cap and TTL independently of the bot memory cache', async () => {
    await activate(); const entry = cachedEntry();
    const value = JSON.stringify(entry);
    if (provider === 'postgres') await (driver as Database).query(`INSERT INTO module_record(guild_id,module_id,key,value,expires_at)
      SELECT $1,'logging','message-cache:'||(100000000000001000::bigint+n)::text,$2::jsonb,now()+interval '1 hour' FROM generate_series(0,4999) AS n`, [guild, value]);
    else {
      const sqlite = new DatabaseSync(`${pb!.directory}/pb_data/data.db`);
      try {
        sqlite.prepare(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<4999)
          INSERT INTO omo_module_record(guild_id,module_id,key,value,updated_at,expires_at)
          SELECT ?,'logging','message-cache:'||CAST(100000000000001000+x AS TEXT),?,?,? FROM n`).run(guild, value, Date.now(), Date.now() + 3600000);
      } finally { sqlite.close(); }
    }
    await syncCache({ upserts: [entry], deletes: [] });
    let count: number;
    if (provider === 'postgres') count = (await (driver as Database).query<{ count: number }>(`SELECT count(*)::int AS count FROM module_record WHERE guild_id=$1 AND module_id='logging'`, [guild]))[0]!.count;
    else {
      const sqlite = new DatabaseSync(`${pb!.directory}/pb_data/data.db`);
      try { count = (sqlite.prepare("SELECT count(*) AS count FROM omo_module_record WHERE module_id='logging'").get() as { count: number }).count; } finally { sqlite.close(); }
    }
    expect(count).toBe(5000);
    const first = await store().call('messageCacheLoad', { cursor: '' });
    expect(first.records).toHaveLength(500); expect(first.nextCursor).toBeTruthy();
    const second = await store().call('messageCacheLoad', { cursor: first.nextCursor! });
    expect(second.records).toHaveLength(500);
    expect(new Set([...first.records, ...second.records].map(record => record.key)).size).toBe(1000);
    await mutateForTest("UPDATE module_record SET expires_at=now()-interval '1 second'", 'UPDATE omo_module_record SET expires_at=0');
    expect((await cacheRecords()).records).toHaveLength(0);
    await syncCache({ upserts: [], deletes: [] });
    expect((await cacheRecords()).records).toHaveLength(0);
  });
  it('prunes persistent snapshots for category, thread-parent, destination and message-switch exclusions', async () => {
    await activate();
    const entry = { ...cachedEntry(), parentId: '100000000000000041', containerId: '100000000000000042' };
    for (const policy of [
      { ...settings, excludedCategoryIds: [entry.parentId] },
      { ...settings, excludedChannelIds: [entry.containerId] },
      { ...settings, destinationId: entry.channelId },
      { ...settings, events: { ...settings.events, 'message.edited': false, 'message.deleted': false } }
    ]) {
      await syncCache({ upserts: [entry], deletes: [] });
      expect((await cacheRecords()).records).toHaveLength(1);
      await repository().apply(policy);
      expect((await cacheRecords()).records).toHaveLength(0);
    }
  });
  it('collects immediate deletions and new-member role updates through the installed production module', async () => {
    const sharedStore = store(), repo = new LoggingRepository(sharedStore);
    const host = new ModuleHost(guild, botRegistry(repo, async () => {}, true), sharedStore, { info() {}, error() {} });
    const pending: Promise<void>[] = [];
    const collector = new ActivityCollector({ guildId: guild, botId: () => destination,
      settings: () => host.activeSettings('logging') as LoggingSettings | null,
      channel: () => ({ parentId: null, containerId: null }),
      member: () => ({ nickname: null, roles: [guild], label: 'New member' }), voiceChannel: () => null,
      emit: observation => { pending.push(host.dispatch(observation)); }, missingMemberBaseline() { throw new Error('Expected a joined member baseline'); }
    });
    const dispatch = (t: string, data: Record<string, unknown>) => collector.handle({ op: 0, t, s: 1, d: { guild_id: guild, ...data } } as GatewayDispatchPayload, t);
    try {
      await sharedStore.updateModule('logging', 1, owner, { enabled: true, settings });
      await host.sync();
      expect((await sharedStore.getModule('logging')).appliedEnabled).toBe(true);
      const channel = '100000000000000031', message = '100000000000000099', member = '100000000000000041';
      dispatch('MESSAGE_CREATE', { id: message, channel_id: channel, author: { id: member, username: 'Member' }, content: 'Deleted immediately', attachments: [] });
      dispatch('MESSAGE_DELETE', { id: message, channel_id: channel });
      dispatch('GUILD_MEMBER_UPDATE', { user: { id: member, username: 'Member' }, nick: null, roles: ['100000000000000051'] });
      dispatch('VOICE_STATE_UPDATE', { user_id: member, channel_id: channel });
      await Promise.all(pending);
      const events = (await repo.list({ limit: 10 })).events;
      expect(events.map(e => e.type).sort()).toEqual(['member.roles.updated', 'message.deleted', 'voice.joined']);
      expect(events.find(e => e.type === 'message.deleted')?.before?.content).toBe('Deleted immediately');
      const titles: string[] = [];
      await new DeliveryWorker(repo, { async validate() {}, async find() { return null; }, async send(_id, payload) { titles.push(payload.embeds[0]!.title); return destination; } }).drain();
      expect(titles).toHaveLength(3);
      expect((await repo.list({ limit: 10 })).events.every(e => e.deliveryState === 'sent')).toBe(true);
      dispatch('MESSAGE_CREATE', { id: '100000000000000098', channel_id: channel, author: { id: member, username: 'Member' }, content: 'Clear on disable', attachments: [] });
      expect(collector.cachedMessages).toBe(1);
      await sharedStore.updateModule('logging', 2, owner, { enabled: false });
      await host.sync();
      dispatch('MESSAGE_DELETE', { id: '100000000000000098', channel_id: channel });
      await Promise.all(pending);
      expect(collector.cachedMessages).toBe(0);
      expect((await repo.list({ limit: 10 })).events).toHaveLength(3);
    } finally { await host.stop(); collector.clear(); }
  });
  async function mutateForTest(pgSql: string, sqliteSql: string) {
    if (provider === 'postgres') await (driver as Database).query(pgSql);
    else { const sqlite = new DatabaseSync(`${pb!.directory}/pb_data/data.db`); try { sqlite.exec(sqliteSql); } finally { sqlite.close(); } }
  }
  it('polls all installed modules and due work together without claiming early', async () => {
    await store().initialize('Test', [exampleDefinition]); await activate();
    const poll = () => store().call('workerPoll', { moduleIds: ['logging', 'example'], jobModuleIds: ['example'], status: 'online', details: { gateway: true } });
    expect(await poll()).toMatchObject({ jobsDue: false, deliveriesDue: 0 });
    const delayed = await store().resources('example').jobs.enqueue('remember', {}, 'later', { delayMs: 60000 });
    await repository().capture(event(), settings, 2);
    const due = await store().resources('example').jobs.enqueue('remember', {}, 'now');
    const snapshot = await poll();
    expect(snapshot.modules.map(m => m.moduleId)).toEqual(['logging', 'example']);
    expect(snapshot).toMatchObject({ jobsDue: true, deliveriesDue: 1 });
    expect((await store().call('jobGet', { id: due })).state).toBe('pending');
    expect((await store().call('jobGet', { id: delayed })).state).toBe('pending');
    const workspace = await store().call('dashboardSnapshot', { moduleIds: ['logging', 'example'] });
    expect(workspace.status.health?.status).toBe('online');
    expect(workspace.events).toHaveLength(1); expect(workspace.events[0]?.deliveryState).toBe('pending');
    expect(workspace.modules).toEqual(snapshot.modules);
    const prepared = (await store().call('deliveryPrepare', {}))!;
    expect(prepared.event.id).toBe(prepared.delivery.event_id); expect(prepared.module.appliedRevision).toBe(2);
    expect((await poll()).deliveriesDue).toBe(0);
    await expect(store().call('workerPoll', { moduleIds: ['bad/id'], jobModuleIds: [], status: 'invalid', details: {} })).rejects.toThrow();
    expect((await store().call('status', {})).health?.status).toBe('online');
    await mutateForTest("UPDATE core_job SET expires_at=now()-interval '1 second'", 'UPDATE omo_job SET expires_at=0');
    expect((await poll()).jobsDue).toBe(false);
  });
  it('refuses to send when settings or claim ownership change during Discord validation', async () => {
    await activate(); await repository().capture(event(), settings, 2);
    let sends = 0;
    const worker = new DeliveryWorker(repository(), { async validate() { await store().updateModule('logging', 2, owner, { enabled: false }); }, async find() { return null; }, async send() { sends++; return destination; } });
    await worker.tick(); expect(sends).toBe(0);
    expect((await repository().list({ limit: 10 })).events[0]?.deliveryState).toBe('pending');
    const changed = await store().getModule('logging'); await store().acknowledge('logging', changed);
    await mutateForTest("UPDATE logging_delivery SET next_attempt=now()", 'UPDATE omo_delivery SET next_attempt=0');
    await worker.tick(); expect(sends).toBe(0);
    expect((await repository().list({ limit: 10 })).events[0]?.deliveryState).toBe('cancelled');
  });
  it('verifies prepared claims and never revives expired sessions by touching them', async () => {
    await activate(); await repository().capture(event(), settings, 2);
    const { delivery, module } = (await store().call('deliveryPrepare', {}))!;
    const check = () => store().call('deliveryVerify', { id: delivery.id, claimToken: delivery.claim_token, revision: module.appliedRevision });
    expect(await check()).toBe(true);
    await mutateForTest("UPDATE logging_delivery SET claim_token='new-owner'", "UPDATE omo_delivery SET claim_token='new-owner'");
    expect(await check()).toBe(false);
    const hash = 'expired-session';
    await store().call('sessionCreate', { id_hash: hash, user_id: owner, label: 'Owner', tokens: 'encrypted', csrf_hash: 'csrf', access: 'owner' });
    expect(await store().call('sessionGet', { hash, touch: true })).not.toBeNull();
    await mutateForTest("UPDATE dashboard_session SET last_seen=now()-interval '25 hours'", 'UPDATE omo_session SET last_seen=0');
    expect(await store().call('sessionGet', { hash, touch: true })).toBeNull();
    expect(await store().call('sessionGet', { hash })).toBeNull();
  });
  it('handles health, catalog and saved/applied revisions identically', async () => {
    await store().ready(); await store().replaceCatalog([{ id: destination, name: 'staff-logs', type: 0, parentId: null, canSend: true }]);
    expect((await store().catalog())[0]?.canSend).toBe(true);
    await activate(); expect((await store().getModule('logging')).appliedEnabled).toBe(true);
    expect((await store().getModule('logging')).appliedSettings).toEqual(settings);
    await store().heartbeat('online', { gateway: true }); await store().incident('A known gap.', null);
    const status = await store().call('status', {}); expect(status.health?.status).toBe('online'); expect(status.incidents[0]?.dropped_count).toBeNull();
  });
  it('stores, filters and delivers every supported activity type without a schema upgrade', async () => {
    await activate();
    for (const type of eventTypes) {
      const sample = previewEvent(type);
      await repository().capture({ ...event(type), type, subjectId: sample.subjectId, label: sample.subjectLabel,
        channelId: sample.channelId ? '100000000000000031' : null, before: sample.before, after: sample.after }, settings, 2);
      const list = await repository().list({ type, limit: 10 });
      expect(list.events).toHaveLength(1); expect(list.events[0]?.before).toEqual(sample.before); expect(list.events[0]?.after).toEqual(sample.after);
    }
    const titles: string[] = [];
    const worker = new DeliveryWorker(repository(), { async validate() {}, async find() { return null; }, async send(_id, payload, marker) {
      titles.push(payload.embeds[0]!.title); expect(payload.allowedMentions.parse).toEqual([]); expect(payload.embeds[0]!.footer.text.endsWith(marker)).toBe(true); return destination;
    } });
    for (let i = 0; i < eventTypes.length; i++) await worker.tick();
    expect(titles.sort()).toEqual(eventTypes.map(t => eventLabels[t]).sort());
    expect((await repository().list({ limit: 50 })).events.every(e => e.deliveryState === 'sent')).toBe(true);
  });
  it('excludes message/voice channels independently of the subject and cancels disabled queued events', async () => {
    await activate();
    const message = { ...event(), type: 'message.deleted', subjectId: '100000000000000099', channelId: '100000000000000031', before: { content: 'Private' }, after: null };
    await repository().capture(message, { ...settings, excludedChannelIds: [message.channelId] }, 2);
    await repository().capture({ ...message, sourceKey: 'destination', channelId: destination }, settings, 2);
    await repository().capture({ ...message, sourceKey: 'disabled' }, { ...settings, events: { ...settings.events, 'message.deleted': false } }, 2);
    expect((await repository().list({ limit: 50 })).events).toHaveLength(0);
    await repository().capture(message, settings, 2);
    const changed = await store().updateModule('logging', 2, owner, { settings: { ...settings, events: { ...settings.events, 'message.deleted': false } } });
    await store().acknowledge('logging', changed);
    await new DeliveryWorker(repository(), { async validate() { throw new Error('Disabled events must not reach Discord'); }, async find() { return null; }, async send() { throw new Error('Must not send'); } }).tick();
    expect((await repository().list({ limit: 50 })).events[0]?.deliveryState).toBe('cancelled');
    const voice = { ...event('voice-excluded'), type: 'voice.joined', subjectId: owner, channelId: message.channelId };
    await repository().capture(voice, { ...settings, excludedChannelIds: [message.channelId] }, 2);
    expect((await repository().list({ type: 'voice.joined', limit: 50 })).events).toHaveLength(0);
  });
  it('rechecks new channel exclusions before delivering already queued message events', async () => {
    await activate(); const observation = { ...event(), type: 'message.deleted', subjectId: '100000000000000099', channelId: '100000000000000031' };
    await repository().capture(observation, settings, 2);
    const changed = await store().updateModule('logging', 2, owner, { settings: { ...settings, excludedChannelIds: [observation.channelId] } });
    await store().acknowledge('logging', changed);
    await new DeliveryWorker(repository(), { async validate() { throw new Error('Must cancel before contacting Discord'); }, async find() { return null; }, async send() { throw new Error('Must not send'); } }).tick();
    expect((await repository().list({ limit: 50 })).events[0]?.deliveryState).toBe('cancelled');
  });
  it('upgrades existing logging settings once while preserving choices and leaving new events off', async () => {
    await activate();
    const legacy = { ...settings, metadataRetentionDays: 7, events: { 'channel.created': false, 'channel.updated': true, 'channel.deleted': false } };
    const json = JSON.stringify(legacy).replaceAll("'", "''");
    await mutateForTest(`UPDATE module_config SET settings_version=1,applied_settings_version=1,settings='${json}'::jsonb,applied_settings='${json}'::jsonb WHERE module_id='logging'`,
      `UPDATE omo_module SET settings_version=1,applied_settings_version=1,settings='${json}',applied_settings='${json}' WHERE module_id='logging'`);
    await store().initialize('Test community', [loggingDefinition]);
    const upgraded = await store().getModule('logging');
    expect(upgraded.settingsVersion).toBe(2); expect(upgraded.settings).toMatchObject(legacy); expect(upgraded.enabled).toBe(true);
    for (const type of eventTypes.filter(t => !t.startsWith('channel.'))) expect((upgraded.settings as typeof settings).events[type]).toBe(false);
    await store().initialize('Test community', [loggingDefinition]);
    expect((await store().getModule('logging')).desiredRevision).toBe(upgraded.desiredRevision);
  });
  it('serializes concurrent settings edits and rejects the stale writer', async () => {
    const outcomes = await Promise.allSettled([store().updateModule('logging', 1, owner, { settings }), store().updateModule('logging', 1, owner, { enabled: true })]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(o => o.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } });
    expect((await store().getModule('logging')).desiredRevision).toBe(2);
  });
  it('deduplicates events and paginates stable IDs without losing repeated actions', async () => {
    await activate(); const observation = event('same-source');
    await Promise.all([repository().capture(observation, settings, 2), repository().capture(observation, settings, 2)]);
    await repository().capture({ ...observation, sourceKey: 'new-action' }, settings, 2);
    const first = await repository().list({ limit: 1 }); expect(first.events).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    const next = await repository().list({ limit: 1, cursor: first.nextCursor! }); expect(next.events).toHaveLength(1); expect(next.events[0]?.id).not.toBe(first.events[0]?.id); expect(next.nextCursor).toBeNull();
    expect((await store().call('status', {})).queue[0]?.count).toBe(2);
    await expect(repository().list({ limit: 1, cursor: 'not-json' })).rejects.toMatchObject({ statusCode: 400 });
  });
  it('claims one delivery at a time and ignores stale finalization tokens', async () => {
    await activate(); await repository().capture(event(), settings, 2);
    const claims = await Promise.all([store().call('deliveryClaim', {}), store().call('deliveryClaim', {})]);
    expect(claims.filter(Boolean)).toHaveLength(1); const claimed = claims.find(Boolean)!;
    await store().call('deliveryFinish', { id: claimed.id, claimToken: randomUUID(), state: 'sent', messageId: destination });
    expect((await repository().detail(claimed.event_id)).deliveryState).toBe('sending');
    await store().call('deliveryFinish', { id: claimed.id, claimToken: claimed.claim_token, state: 'sent', messageId: destination });
    expect((await repository().detail(claimed.event_id)).deliveryState).toBe('sent');
  });
  it('recovers an expired lease and never accepts the old claim after reclaim', async () => {
    await activate(); await repository().capture(event(), settings, 2);
    const original = (await store().call('deliveryClaim', {}))!;
    await mutateForTest(`UPDATE logging_delivery SET lease_until=now()-interval '1 second'`, `UPDATE omo_delivery SET lease_until=0`);
    const reclaimed = (await store().call('deliveryClaim', {}))!;
    expect(reclaimed.claim_token).not.toBe(original.claim_token); expect(reclaimed.attempts).toBe(2);
    await store().call('deliveryFinish', { id: original.id, claimToken: original.claim_token, state: 'failed' });
    expect((await repository().detail(original.event_id)).deliveryState).toBe('sending');
    await store().call('deliveryFinish', { id: reclaimed.id, claimToken: reclaimed.claim_token, state: 'sent', messageId: destination });
    expect((await repository().detail(original.event_id)).deliveryState).toBe('sent');
  });
  it('preserves queued work through a storage reconnect or PocketBase restart', async () => {
    await activate(); await repository().capture(event(), settings, 2);
    await release!(); release = undefined;
    if (provider === 'pocketbase') await pb!.restart();
    else { await driver.close(); driver = new Database(pg!.url); }
    release = await driver.singleton(guild, () => {});
    expect((await store().getModule('logging')).desiredRevision).toBe(2);
    let sends = 0;
    await new DeliveryWorker(repository(), { async validate() {}, async find() { return null; }, async send() { sends++; return destination; } }).tick();
    expect(sends).toBe(1); expect((await repository().list({ limit: 50 })).events[0]?.deliveryState).toBe('sent');
  });
  it('enforces exclusions and event expiry before queue claims and retries', async () => {
    await activate(); const observation = event();
    await repository().capture(observation, { ...settings, excludedChannelIds: [observation.subjectId] }, 2);
    expect((await repository().list({ limit: 50 })).events).toHaveLength(0);
    await repository().capture(observation, settings, 2); const claim = (await store().call('deliveryClaim', {}))!;
    await store().call('deliveryFinish', { id: claim.id, claimToken: claim.claim_token, state: 'blocked' });
    await mutateForTest(`UPDATE logging_event SET expires_at=now()-interval '1 second'`, `UPDATE omo_event SET expires_at=0`);
    expect(await store().call('deliveryRetry', { id: claim.id })).toBe(false);
    expect(await store().call('deliveryClaim', {})).toBeNull();
    await repository().cleanup(); expect((await store().call('status', {})).queue).toHaveLength(0);
  });
  it('persists idempotent jobs, expires stale requests and fences job completion', async () => {
    const key = randomUUID(), id = await store().enqueueJob('logging', 'test', {}, key);
    expect(await store().enqueueJob('logging', 'test', {}, key)).toBe(id);
    const job = (await store().call('jobClaim', {}))!;
    await store().call('jobFinish', { id, claimToken: randomUUID(), error: null, message: 'wrong' });
    expect((await store().call('jobGet', { id })).state).toBe('sending');
    await store().call('jobFinish', { id, claimToken: job.claim_token!, error: null, message: 'right' });
    expect((await store().call('jobGet', { id })).result?.message).toBe('right');
    const stale = await store().enqueueJob('logging', 'test', {}, randomUUID());
    await mutateForTest(`UPDATE core_job SET expires_at=now()-interval '1 second' WHERE id='${stale}'`, `UPDATE omo_job SET expires_at=0 WHERE id='${stale}'`);
    await store().cleanup(); expect((await store().call('jobGet', { id: stale })).state).toBe('expired');
  });
  it('consumes OAuth state once and isolates/invalidates encrypted sessions', async () => {
    const hash = randomUUID(); await store().call('oauthCreate', { hash });
    expect(await store().call('oauthConsume', { hash })).toBe(true); expect(await store().call('oauthConsume', { hash })).toBe(false);
    await store().call('sessionCreate', { id_hash: hash, user_id: owner, label: 'Owner', tokens: 'encrypted', csrf_hash: 'hashed-csrf', access: 'owner' });
    expect((await store().call('sessionGet', { hash }))?.tokens).toBe('encrypted');
    await store().call('sessionRefresh', { hash, tokens: 'new-encrypted', access: 'viewer' }); await store().call('sessionTouch', { hash });
    expect((await store().call('sessionGet', { hash }))?.access).toBe('viewer');
    await store().call('sessionDelete', { hash }); expect(await store().call('sessionGet', { hash })).toBeNull();
  });
  it('rejects a competing worker and allows clean takeover', async () => {
    const second = provider === 'postgres' ? new Database(pg!.url) : new PocketBaseAdapter(pb!.url, pb!.key);
    try {
      await expect(second.singleton(guild, () => {})).rejects.toThrow('Another bot');
      await release!(); release = undefined;
      const cleanup = await second.singleton(guild, () => {}); await cleanup();
    } finally { await second.close(); }
  });
  it('runs the protected API and rejects CSRF, viewers and revoked membership', async () => {
    let member = true;
    const config = readConfig({ NODE_ENV: 'test', STORAGE_PROVIDER: provider, ...(provider === 'postgres' ? { DATABASE_URL: pg!.url } : { POCKETBASE_URL: pb!.url, POCKETBASE_SERVICE_KEY: pb!.key }), DISCORD_GUILD_ID: guild, OWNER_USER_IDS: owner, DASHBOARD_ORIGIN: 'http://localhost:3000' });
    const { app } = await createServer({ config, db: driver, demo: true, clientId: 'fixture', encryptionKey: 'a'.repeat(64), identity: { async exchange() { throw new Error('unused'); }, async identity() { throw new Error('unused'); }, async membership(tokens) { if (!member) throw new Error('revoked'); return { tokens, roles: [] }; } } });
    try {
      expect((await app.inject('/api/modules/logging/events')).statusCode).toBe(401);
      expect((await app.inject('/api/workspace')).statusCode).toBe(401);
      const login = await app.inject('/auth/demo'), cookies = { omo_session: login.cookies.find(c => c.name === 'omo_session')!.value };
      const me = (await app.inject({ url: '/api/me', cookies })).json().data;
      expect(me.access).toBe('owner');
      const workspace = (await app.inject({ url: '/api/workspace', cookies })).json().data;
      expect(workspace.user.userId).toBe(owner); expect(workspace.status.storageProvider).toBe(provider);
      expect(workspace.modules.map((m: { moduleId: string }) => m.moduleId)).toEqual(['logging', 'example']);
      for(let i=0;i<121;i++) await app.inject('/health/live');
      expect((await app.inject('/auth/demo')).statusCode).toBe(302);
      const inactive = await app.inject({url:'/api/modules/example/tasks',method:'POST',cookies,headers:{origin:'http://localhost:3000','x-csrf-token':me.csrf},payload:{key:randomUUID()}});
      expect(inactive.statusCode).toBe(409);
      const privateJob=await store().enqueueJob('example','remember',{privateInput:'fixture-only'},randomUUID());
      const publicJob=(await app.inject({url:`/api/jobs/${privateJob}`,cookies})).json().data;
      expect(publicJob).not.toHaveProperty('payload');expect(publicJob).not.toHaveProperty('claim_token');

      let limited=0;for(let i=0;i<21;i++) limited=(await app.inject('/auth/discord')).statusCode;
      expect(limited).toBe(429);

      expect((await app.inject({ url: '/api/status', cookies })).json().data.storageProvider).toBe(provider);
      expect((await app.inject({ url: '/api/modules/logging/test', method: 'POST', cookies, headers: { origin: 'http://localhost:3000', 'x-csrf-token': 'forged' }, payload: { key: randomUUID() } })).statusCode).toBe(403);
      member = false;
      expect((await app.inject({ url: '/api/modules/logging/test', method: 'POST', cookies, headers: { origin: 'http://localhost:3000', 'x-csrf-token': me.csrf }, payload: { key: randomUUID() } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/workspace', cookies })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it('isolates module records and fences concurrent edits with bounded pagination', async () => {
    await store().initialize('Test community', [exampleDefinition]);
    const first = store().resources('logging').data, second = store().resources('example').data;
    await first.put('same', { private: 'logging' }, 0);
    expect(await second.get('same')).toBeNull();
    await second.put('same', { private: 'example' }, 0);
    const writes = await Promise.allSettled([second.put('same', { n: 1 }, 1), second.put('same', { n: 2 }, 1)]);
    expect(writes.filter(w => w.status === 'fulfilled')).toHaveLength(1);
    expect(writes.find(w => w.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } });
    expect((await first.get('same'))?.value).toEqual({ private: 'logging' });
    await second.put('event%a', {}, 0); await second.put('event%b', {}, 0); await second.put('event-other', {}, 0);
    const page = await second.list({ prefix: 'event%', limit: 1 });
    expect(page.records.map(r => r.key)).toEqual(['event%a']);
    expect((await second.list({ prefix: 'event%', limit: 1, cursor: page.nextCursor! })).records.map(r => r.key)).toEqual(['event%b']);
    await expect(second.put('large', { value: 'x'.repeat(33000) }, 0)).rejects.toThrow();
    await expect(second.delete('same', 1)).rejects.toMatchObject({ statusCode: 409 });
    expect(await second.delete('same', 2)).toBe(true);
    if (provider === 'postgres') {
      const other = driver.scope('200000000000000001'); await other.initialize('Other', [exampleDefinition]);
      expect(await other.resources('example').data.get('event%a')).toBeNull();
    }
  });
  it('expires module records and preserves live data across database restart', async () => {
    const data=store().resources('logging').data;
    await data.put('expire', { n:1 }, 0, 1000); await data.put('persist', { n:2 }, 0);
    await mutateForTest("UPDATE module_record SET expires_at=now()-interval '1 second' WHERE key='expire'", "UPDATE omo_module_record SET expires_at=0 WHERE key='expire'");
    expect(await data.get('expire')).toBeNull();
    await expect(data.put('expire', {}, 1)).rejects.toMatchObject({statusCode:409});
    await store().cleanup();
    await release!(); release=undefined;
    if (provider==='pocketbase') await pb!.restart(); else {await driver.close(); driver=new Database(pg!.url);}
    release=await driver.singleton(guild,()=>{});
    expect((await store().resources('logging').data.get('persist'))?.value).toEqual({n:2});
  });
  it('upgrades versioned settings once while preserving applied configuration', async () => {
    await store().initialize('Test', [exampleDefinition]);
    const upgraded={...exampleDefinition,manifest:{...exampleDefinition.manifest,settingsVersion:2},settingsMigrations:{1:(old:unknown)=>({greeting:z.object({greeting:z.string()}).parse(old).greeting+' Upgraded.'})}};
    await Promise.all([store().initialize('Test',[upgraded]),store().initialize('Test',[upgraded])]);
    const state=await store().getModule('example');
    expect(state.settingsVersion).toBe(2); expect(state.desiredRevision).toBe(2);
    expect(state.appliedSettingsVersion).toBe(1); expect(state.appliedSettings).toEqual(exampleDefinition.defaultSettings);
    await expect(store().initialize('Test',[exampleDefinition])).rejects.toThrow('newer');
    await expect(store().initialize('Test',[{...upgraded,manifest:{...upgraded.manifest,settingsVersion:3},settingsMigrations:{}}])).rejects.toThrow('missing settings migration');
    expect((await store().getModule('example')).desiredRevision).toBe(2);
  });
  it('dispatches generic jobs only to active modules and persists their own result', async () => {
    await store().initialize('Test', [exampleDefinition]);
    const host=new ModuleHost(guild,[exampleModule()],store(),{info(){},error(){}});
    const jobs=store().resources('example').jobs;
    const id=await jobs.enqueue('remember',{},'one');
    await host.sync(); await runModuleJobs(store(),host);
    expect((await store().call('jobGet',{id})).state).toBe('pending');
    const loggingJob=await store().enqueueJob('logging','test',{},'other-module');
    await store().updateModule('example',1,owner,{enabled:true}); await host.sync();
    await runModuleJobs(store(),host);
    expect((await store().call('jobGet',{id})).state).toBe('completed');
    expect((await store().call('jobGet',{id})).module_id).toBe('example');
    expect((await store().resources('example').data.get<{jobId:string}>('last-task'))?.value.jobId).toBe(id);
    expect((await store().call('jobGet',{id:loggingJob})).state).toBe('pending');
    expect(await jobs.enqueue('remember',{},'one')).toBe(id);
    const delayed=await jobs.enqueue('remember',{},'later',{delayMs:60000,ttlMs:1000});
    await runModuleJobs(store(),host); expect((await store().call('jobGet',{id:delayed})).state).toBe('pending');
    const invalid=await jobs.enqueue('remember',{secret:'never return this'},'invalid');
    await runModuleJobs(store(),host); const failed=await store().call('jobGet',{id:invalid});
    expect(failed.state).toBe('failed'); expect(failed.error).not.toContain('secret');
    await host.stop();
  });
  it('reclaims a generic job and ignores stale or expired completion', async () => {
    await store().initialize('Test',[exampleDefinition]);
    const id=await store().resources('example').jobs.enqueue('remember',{n:4},'claim');
    const first=(await store().call('jobClaim',{moduleIds:['example']}))!;
    expect(first.payload).toEqual({n:4});
    await mutateForTest("UPDATE core_job SET lease_until=now()-interval '1 second'",'UPDATE omo_job SET lease_until=0');
    const second=(await store().call('jobClaim',{moduleIds:['example']}))!;
    expect(second.attempts).toBe(2); expect(second.claim_token).not.toBe(first.claim_token);
    await store().call('jobFinish',{id,claimToken:first.claim_token!,error:null,message:'stale'});
    expect((await store().call('jobGet',{id})).result).toBeNull();
    await mutateForTest("UPDATE core_job SET expires_at=now()-interval '1 second'",'UPDATE omo_job SET expires_at=0');
    await store().call('jobFinish',{id,claimToken:second.claim_token!,error:null,message:'expired'});
    expect((await store().call('jobGet',{id})).result).toBeNull();
  });
  if (provider === 'pocketbase') {
    it('fences an expired owner before another worker takes over', async () => {
      await mutateForTest('', 'UPDATE omo_lease SET expires_at=0');
      const second = new PocketBaseAdapter(pb!.url, pb!.key);
      const releaseSecond = await second.singleton(guild, () => {});
      try {
        await expect(store().call('workerVerify', {})).rejects.toMatchObject({ statusCode: 409 });
        await expect(store().call('workerPoll', { moduleIds: ['logging'], jobModuleIds: [], status: 'online', details: {} })).rejects.toMatchObject({ code: 'LEASE_LOST' });
        await expect(store().call('messageCacheLoad', { cursor: '' })).rejects.toMatchObject({ code: 'LEASE_LOST' });
        await expect(store().call('deliveryPrepare', {})).rejects.toMatchObject({ code: 'LEASE_LOST' });
        await expect(store().call('deliveryVerify', { id: randomUUID(), claimToken: randomUUID(), revision: 2 })).rejects.toMatchObject({ code: 'LEASE_LOST' });
        await release!(); release = undefined;
        await expect(second.scope(guild).call('workerVerify', {})).resolves.toBeNull();
      } finally { await releaseSecond(); await second.close(); }
    });
    it('rejects wrong storage keys, other guilds, unknown operations and ownerless worker writes', async () => {
      await expect(new PocketBaseAdapter(pb!.url, '0'.repeat(64)).scope(guild).ready()).rejects.toThrow('storage access failed');
      await expect(driver.scope('200000000000000001').ready()).rejects.toMatchObject({ statusCode: 403 });
      const response = await fetch(`${pb!.url}/api/omo/v1/query`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-OMO-Storage-Key': pb!.key }, body: JSON.stringify({ guildId: guild, input: { sql: 'SELECT * FROM omo_session' } }) });
      expect(response.status).toBe(404);
      const other = new PocketBaseAdapter(pb!.url, pb!.key);
      await expect(other.scope(guild).heartbeat('online', {})).rejects.toMatchObject({ statusCode: 409 });
    });
    it('rolls back the event if queue insertion fails', async () => {
      await activate();
      await mutateForTest('', `CREATE TRIGGER reject_delivery BEFORE INSERT ON omo_delivery BEGIN SELECT RAISE(ABORT, 'test rollback'); END;`);
      await expect(repository().capture(event(), settings, 2)).rejects.toMatchObject({ statusCode: 503 });
      expect((await repository().list({ limit: 50 })).events).toHaveLength(0);
      expect((await store().call('status', {})).queue).toHaveLength(0);
    });
  }
});
