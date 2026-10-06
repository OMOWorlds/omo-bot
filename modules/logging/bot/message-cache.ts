import type { GuildStore } from '../../../packages/db/src/index.js';
import type { ActivityCollector } from './collect.js';
import { MESSAGE_CACHE_PREFIX, MESSAGE_CACHE_LIMIT, MESSAGE_CACHE_BATCH_LIMIT, MESSAGE_CACHE_BATCH_BYTES,
  messageCacheEntrySchema, type MessageCacheEntry, type MessageCacheBatch } from '../shared/message-cache.js';

/** Only acknowledged snapshots are compared with memory, so failed or overlapping writes remain retryable. */
export class PersistentMessageCache {
  private persisted = new Map<string, MessageCacheEntry>();
  private loaded = false;
  constructor(private store: GuildStore, private collector: ActivityCollector) {}
  async restore() {
    const entries: MessageCacheEntry[] = [];
    let cursor = '';
    do {
      const page = await this.store.call('messageCacheLoad', { cursor });
      for (const record of page.records) {
        const entry = messageCacheEntrySchema.parse(record.value);
        if (record.key !== `${MESSAGE_CACHE_PREFIX}${entry.id}`) throw new Error('Invalid persisted message cache key.');
        entries.push(entry);
      }
      cursor = page.nextCursor ?? '';
    } while (cursor && entries.length < MESSAGE_CACHE_LIMIT);
    this.persisted = new Map(entries.map(entry => [entry.id, entry]));
    this.collector.restoreMessages(entries);
    this.loaded = true;
  }
  prepare(): MessageCacheBatch | undefined {
    if (!this.loaded) return;
    const current = this.collector.messageEntries();
    const deletes = [...this.persisted.keys()].filter(id => !current.has(id));
    const upserts: MessageCacheEntry[] = [];
    let bytes = Buffer.byteLength(JSON.stringify({ upserts, deletes }));
    for (const entry of current.values()) {
      if (this.persisted.get(entry.id) === entry) continue;
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (upserts.length >= MESSAGE_CACHE_BATCH_LIMIT || bytes + size > MESSAGE_CACHE_BATCH_BYTES) break;
      upserts.push(entry); bytes += size;
    }
    return upserts.length || deletes.length ? { upserts, deletes } : undefined;
  }
  acknowledge(batch: MessageCacheBatch) {
    for (const id of batch.deletes) this.persisted.delete(id);
    for (const entry of batch.upserts) this.persisted.set(entry.id, entry);
  }
}
