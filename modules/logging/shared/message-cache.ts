import { z } from 'zod';
import { snowflake } from '../../../packages/module-sdk/src/browser.js';
import type { LoggingSettings } from './settings.js';
import { excludedEvent } from './policy.js';

export const MESSAGE_CACHE_LIMIT = 5000;
export const MESSAGE_CACHE_TTL = 24 * 60 * 60 * 1000;
export const MESSAGE_CACHE_PREFIX = 'message-cache:';
export const MESSAGE_CACHE_BATCH_LIMIT = 100;
export const MESSAGE_CACHE_BATCH_BYTES = 512 * 1024;
export const messageCacheEntrySchema = z.object({
  id: snowflake, channelId: snowflake, parentId: snowflake.nullable(), containerId: snowflake.nullable(),
  savedAt: z.number().int().nonnegative(),
  snapshot: z.object({
    authorId: snowflake.nullable(), authorName: z.string().max(100).nullable(),
    content: z.string().max(4000).nullable(), contentTruncated: z.boolean(),
    attachments: z.array(z.object({ id: z.string().max(100), name: z.string().max(256) }).strict()).max(10).nullable(),
    attachmentsTruncated: z.boolean()
  }).strict()
}).strict();
export type MessageCacheEntry = z.infer<typeof messageCacheEntrySchema>;
export type MessageSnapshot = MessageCacheEntry['snapshot'];
export const messageCacheBatchSchema = z.object({
  upserts: z.array(messageCacheEntrySchema).max(MESSAGE_CACHE_BATCH_LIMIT),
  deletes: z.array(snowflake).max(MESSAGE_CACHE_LIMIT)
}).strict().refine(batch => new Set(batch.upserts.map(entry => entry.id)).size === batch.upserts.length)
  .refine(batch => new TextEncoder().encode(JSON.stringify(batch)).length <= MESSAGE_CACHE_BATCH_BYTES);
export type MessageCacheBatch = z.infer<typeof messageCacheBatchSchema>;
export function cacheEntryAllowed(entry: MessageCacheEntry, settings: LoggingSettings | null) {
  return !!settings && (settings.events['message.edited'] || settings.events['message.deleted'])
    && !excludedEvent({ type: 'message.deleted', subjectId: entry.id, channelId: entry.channelId,
      parentId: entry.parentId, before: null, after: { containerId: entry.containerId } }, settings);
}
