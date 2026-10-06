import { expect, it } from 'vitest';
import type { GatewayDispatchPayload } from 'discord.js';
import { GuildStore } from '../../../packages/db/src/index.js';
import type { StorageDriver } from '../../../packages/db/src/contracts.js';
import { ActivityCollector } from '../bot/collect.js';
import { PersistentMessageCache } from '../bot/message-cache.js';
import { defaultLoggingSettings } from '../shared/settings.js';
import { MESSAGE_CACHE_TTL, MESSAGE_CACHE_BATCH_BYTES, messageCacheBatchSchema, type MessageCacheEntry } from '../shared/message-cache.js';
import type { Observation } from '../../../packages/module-sdk/src/server.js';

const guild = '100000000000000001', channel = '100000000000000010', author = '100000000000000002', id = '100000000000000030';
function fixture(saved: MessageCacheEntry[] = []) {
  const events: Observation[] = [];
  const collector = new ActivityCollector({ guildId: guild, botId: () => '100000000000000003', settings: () => defaultLoggingSettings,
    channel: () => ({ parentId: null, containerId: null, name: 'general' }), member: () => null, voiceChannel: () => null,
    emit: event => events.push(event), missingMemberBaseline() {}
  });
  const store = new GuildStore({ call: async () => ({ records: saved.map(entry => ({ key: `message-cache:${entry.id}`, value: entry })), nextCursor: null }) } as unknown as StorageDriver, guild);
  const cache = new PersistentMessageCache(store, collector);
  const dispatch = (t: string, patch: Record<string, unknown> = {}) => collector.handle({ op: 0, s: 1, t, d: {
    guild_id: guild, channel_id: channel, id, ...patch
  } } as GatewayDispatchPayload, t);
  const create = (patch: Record<string, unknown> = {}) => dispatch('MESSAGE_CREATE', { author: { id: author, username: 'Member' }, content: 'Saved text', attachments: [], ...patch });
  return { collector, cache, dispatch, create, events };
}
it('does not overwrite persistent storage before restore and saves only changed snapshots', async () => {
  const f = fixture(); f.create(); expect(f.cache.prepare()).toBeUndefined();
  await f.cache.restore(); const batch = f.cache.prepare()!;
  expect(batch.upserts[0]?.snapshot.content).toBe('Saved text');
  expect(f.cache.prepare()).toEqual(batch); // A failed request stays retryable.
  f.cache.acknowledge(batch); expect(f.cache.prepare()).toBeUndefined();
  f.dispatch('MESSAGE_UPDATE', { content: 'New text' });
  expect(f.cache.prepare()?.upserts[0]?.snapshot.content).toBe('New text');
});
it('retains updates and deletions that arrive while a previous batch is in flight', async () => {
  const f = fixture(); await f.cache.restore(); f.create(); const first = f.cache.prepare()!;
  f.dispatch('MESSAGE_UPDATE', { content: 'New text' }); f.cache.acknowledge(first);
  const second = f.cache.prepare()!; expect(second.upserts[0]?.snapshot.content).toBe('New text');
  f.dispatch('MESSAGE_DELETE'); f.cache.acknowledge(second);
  expect(f.cache.prepare()).toEqual({ upserts: [], deletes: [id] });
  f.cache.acknowledge(f.cache.prepare()!); expect(f.cache.prepare()).toBeUndefined();
});
it('restores saved authors and content without renewing the snapshot expiry', async () => {
  const original = fixture(); original.create();
  const entry = original.collector.messageEntries().get(id)!;
  entry.savedAt -= 3600000;
  const f = fixture([entry]); await f.cache.restore(); expect(f.cache.prepare()).toBeUndefined();
  f.dispatch('MESSAGE_DELETE');
  expect(f.events[0]?.before).toMatchObject({ authorId: author, content: 'Saved text' });
  const expired = fixture([{ ...entry, savedAt: Date.now() - MESSAGE_CACHE_TTL }]);
  await expired.cache.restore(); expect(expired.collector.cachedMessages).toBe(0);
  expect(expired.cache.prepare()?.deletes).toEqual([id]);
});
it('never replaces a newer live snapshot with a restored one', async () => {
  const old = fixture(); old.create();
  const f = fixture([...old.collector.messageEntries().values()]); f.create({ content: 'Live text' });
  await f.cache.restore(); f.dispatch('MESSAGE_DELETE');
  expect(f.events[0]?.before?.content).toBe('Live text');
});
it('bounds Unicode-heavy batches below the PocketBase request limit', async () => {
  const f = fixture(); await f.cache.restore();
  for (let i = 0; i < 120; i++) f.create({ id: String(BigInt(id) + BigInt(i)), content: '漢'.repeat(4000),
    attachments: Array.from({ length: 10 }, (_, i) => ({ id: String(i), filename: '漢'.repeat(256) })) });
  const batch = f.cache.prepare()!;
  expect(batch.upserts.length).toBeGreaterThan(0); expect(batch.upserts.length).toBeLessThan(100);
  expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(MESSAGE_CACHE_BATCH_BYTES);
  expect(messageCacheBatchSchema.safeParse(batch).success).toBe(true);
  f.cache.acknowledge(batch); expect(f.cache.prepare()?.upserts.length).toBeGreaterThan(0);
});
