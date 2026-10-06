import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { PostgresGuildStore } from './postgres.js';
import type { Observation } from '../../module-sdk/src/server.js';
import { filterEventTypes, loggingSettingsSchema, type LoggingSettings, type LogEvent } from '../../../modules/logging/shared/settings.js';
import { HttpError } from '../../core/src/access.js';
import type { PoolClient } from 'pg';
import type { ModuleRecord } from '../../module-sdk/src/services.js';
import { MESSAGE_CACHE_PREFIX, MESSAGE_CACHE_LIMIT, MESSAGE_CACHE_TTL, messageCacheBatchSchema, cacheEntryAllowed, type MessageCacheBatch } from '../../../modules/logging/shared/message-cache.js';

const selection = `e.id,e.type,e.subject_id AS "subjectId",e.subject_label AS "subjectLabel",e.channel_id AS "channelId",e.parent_id AS "parentId",
  e.observed_at AS "observedAt",e.before_value AS before,e.after_value AS after,e.actor_id AS "actorId",e.reason,e.attribution,
  e.config_revision AS "configRevision",e.expires_at AS "expiresAt",d.state AS "deliveryState",d.message_id AS "messageId",d.destination_id AS "destinationId"`;
export const eventFilter = z.object({
  type: z.enum(filterEventTypes).optional(),
  subject: z.string().regex(/^\d{17,20}$/).optional(),
  cursor: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();
export class PostgresLoggingRepository {
  constructor(readonly store: PostgresGuildStore) {}
  async loadMessageCache(cursor: string) {
    z.string().regex(/^(message-cache:\d{17,20})?$/).parse(cursor);
    const records = await this.store.db.query<ModuleRecord>(`SELECT key,value,revision,updated_at AS "updatedAt" FROM module_record
      WHERE guild_id=$1 AND module_id='logging' AND key LIKE $2 AND key COLLATE "C">$3 AND expires_at>now() ORDER BY key COLLATE "C" LIMIT 501`,
    [this.store.guildId, `${MESSAGE_CACHE_PREFIX}%`, cursor]);
    const more = records.length > 500; if (more) records.pop();
    return { records, nextCursor: more ? records.at(-1)!.key : null };
  }
  private async pruneMessageCache(client: PoolClient, settings: LoggingSettings | null) {
    await client.query(`DELETE FROM module_record WHERE guild_id=$1 AND module_id='logging' AND key LIKE $2 AND
      (expires_at<=now() OR $3::boolean OR value->>'channelId'=$4 OR value->>'id'=ANY($5::text[])
      OR value->>'channelId'=ANY($5::text[]) OR value->>'containerId'=ANY($5::text[])
      OR value->>'id'=ANY($6::text[]) OR value->>'parentId'=ANY($6::text[]))`,
    [this.store.guildId, `${MESSAGE_CACHE_PREFIX}%`, !settings || !(settings.events['message.edited'] || settings.events['message.deleted']),
      settings?.destinationId ?? null, settings?.excludedChannelIds ?? [], settings?.excludedCategoryIds ?? []]);
  }
  async syncMessageCache(input: MessageCacheBatch) {
    const batch = messageCacheBatchSchema.parse(input), now = Date.now();
    await this.store.db.transaction(async client => {
      const module = (await client.query(`SELECT enabled,applied_enabled,applied_settings FROM module_config WHERE guild_id=$1 AND module_id='logging' FOR UPDATE`, [this.store.guildId])).rows[0];
      const settings = module?.enabled && module.applied_enabled ? loggingSettingsSchema.parse(module.applied_settings) : null;
      await this.pruneMessageCache(client, settings);
      await client.query(`DELETE FROM module_record WHERE guild_id=$1 AND module_id='logging' AND key=ANY($2::text[])`,
        [this.store.guildId, batch.deletes.map(id => `${MESSAGE_CACHE_PREFIX}${id}`)]);
      const entries = batch.upserts.filter(entry => entry.savedAt <= now && now - entry.savedAt < MESSAGE_CACHE_TTL && cacheEntryAllowed(entry, settings));
      if (entries.length) await client.query(`INSERT INTO module_record(guild_id,module_id,key,value,expires_at)
        SELECT $1,'logging',$2||(entry->>'id'),entry,to_timestamp(((entry->>'savedAt')::bigint+$4)/1000.0)
        FROM jsonb_array_elements($3::jsonb) AS entry
        ON CONFLICT(guild_id,module_id,key) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at,revision=module_record.revision+1,updated_at=now()`,
      [this.store.guildId, MESSAGE_CACHE_PREFIX, JSON.stringify(entries), MESSAGE_CACHE_TTL]);
      await client.query(`DELETE FROM module_record WHERE guild_id=$1 AND module_id='logging' AND key IN
        (SELECT key FROM module_record WHERE guild_id=$1 AND module_id='logging' AND key LIKE $2 ORDER BY expires_at DESC,key DESC OFFSET $3)`,
      [this.store.guildId, `${MESSAGE_CACHE_PREFIX}%`, MESSAGE_CACHE_LIMIT]);
    });
  }
  excluded(event: { subjectId: string; parentId: string | null }, settings: LoggingSettings): boolean {
    return settings.excludedChannelIds.includes(event.subjectId) || settings.excludedCategoryIds.includes(event.subjectId) || (event.parentId !== null && settings.excludedCategoryIds.includes(event.parentId));
  }
  async capture(event: Observation, settings: LoggingSettings, revision: number) {
    if (event.guildId !== this.store.guildId || this.excluded(event, settings)) return;
    if (event.type !== 'logging.test' && !settings.events[event.type as keyof LoggingSettings['events']]) return;
    if (event.type === 'channel.updated' && JSON.stringify(event.before) === JSON.stringify(event.after)) return;
    await this.store.db.transaction(async client => {
      const id = randomUUID();
      const result = await client.query(`INSERT INTO logging_event(id,guild_id,type,source_key,subject_id,subject_label,channel_id,parent_id,observed_at,before_value,after_value,config_revision,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$9::timestamptz+($13::int*interval '1 day')) ON CONFLICT(guild_id,source_key) DO NOTHING RETURNING id`,
      [id, this.store.guildId, event.type, event.sourceKey, event.subjectId, event.label, event.channelId, event.parentId, event.observedAt,
        event.before ? JSON.stringify(event.before) : null, event.after ? JSON.stringify(event.after) : null, revision, settings.metadataRetentionDays]);
      if (result.rowCount && settings.destinationId) {
        const marker = createHash('sha256').update(`${id}:${settings.destinationId}`).digest('hex').slice(0, 24);
        await client.query(`INSERT INTO logging_delivery(id,guild_id,event_id,destination_id,marker) VALUES($1,$2,$3,$4,$5)`, [randomUUID(), this.store.guildId, id, settings.destinationId, marker]);
      }
    });
  }
  async list(input: z.infer<typeof eventFilter>): Promise<{ events: LogEvent[]; nextCursor: string | null }> {
    let cursor: { time: string; id: string } | undefined;
    if (input.cursor) {
      try { cursor = z.object({ time: z.iso.datetime(), id: z.uuid() }).parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString())); }
      catch { throw new HttpError(400, 'INVALID_CURSOR', 'Invalid event cursor.'); }
    }
    const rows = await this.store.db.query<LogEvent>(`SELECT ${selection} FROM logging_event e LEFT JOIN logging_delivery d ON d.event_id=e.id AND d.guild_id=e.guild_id
      WHERE e.guild_id=$1 AND e.expires_at>now() AND ($2::text IS NULL OR e.type=$2) AND ($3::text IS NULL OR e.subject_id=$3)
      AND ($4::timestamptz IS NULL OR (e.observed_at,e.id)<($4::timestamptz,$5::uuid))
      ORDER BY e.observed_at DESC,e.id DESC LIMIT $6`, [this.store.guildId, input.type ?? null, input.subject ?? null, cursor?.time ?? null, cursor?.id ?? null, input.limit + 1]);
    const events = rows.slice(0, input.limit).map(serializeEvent);
    const last = events.at(-1);
    return { events, nextCursor: rows.length > input.limit && last ? Buffer.from(JSON.stringify({ time: last.observedAt, id: last.id })).toString('base64url') : null };
  }
  async detail(id: string): Promise<LogEvent> {
    const [row] = await this.store.db.query<LogEvent>(`SELECT ${selection} FROM logging_event e LEFT JOIN logging_delivery d ON d.event_id=e.id AND d.guild_id=e.guild_id WHERE e.guild_id=$1 AND e.id=$2 AND e.expires_at>now()`, [this.store.guildId, id]);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Event not found or expired.');
    return serializeEvent(row);
  }
  async apply(settings: LoggingSettings) {
    // Update pending routes and policy atomically. Stored metadata still follows retention.
    await this.store.db.transaction(async client => {
      await this.pruneMessageCache(client, settings);
      await client.query(`UPDATE logging_event SET expires_at=LEAST(expires_at,observed_at+($2::int*interval '1 day')) WHERE guild_id=$1`, [this.store.guildId, settings.metadataRetentionDays]);
      await client.query(`UPDATE logging_delivery d SET state='cancelled',lease_until=NULL FROM logging_event e
        WHERE d.guild_id=$1 AND e.id=d.event_id AND d.state IN ('pending','blocked','failed','sending') AND
        (e.expires_at<=now() OR e.subject_id=ANY($2::text[]) OR e.parent_id=ANY($3::text[]) OR e.subject_id=ANY($3::text[]) OR $4::text IS NULL)`,
      [this.store.guildId, settings.excludedChannelIds, settings.excludedCategoryIds, settings.destinationId]);
      if (settings.destinationId) await client.query(`UPDATE logging_delivery SET destination_id=$2,state='pending',next_attempt=now(),last_error=NULL,
        marker=substr(md5(event_id::text||':'||$2),1,24) WHERE guild_id=$1 AND state IN ('pending','blocked','failed')`, [this.store.guildId, settings.destinationId]);
    });
  }
  async cancelPending() {
    await this.store.db.transaction(async client => {
      await this.pruneMessageCache(client, null);
      await client.query(`UPDATE logging_delivery SET state='cancelled',lease_until=NULL WHERE guild_id=$1 AND state IN ('pending','blocked','failed','sending')`, [this.store.guildId]);
    });
  }
  async cleanup() { await this.store.db.query('DELETE FROM logging_event WHERE guild_id=$1 AND expires_at<=now()', [this.store.guildId]); }
  async activeSettings(): Promise<{ settings: LoggingSettings; revision: number; enabled: boolean }> {
    const config = await this.store.getModule('logging');
    return { settings: loggingSettingsSchema.parse(config.appliedSettings), revision: config.appliedRevision, enabled: config.appliedEnabled };
  }
}
function serializeEvent(row: LogEvent): LogEvent {
  return { ...row, observedAt: new Date(row.observedAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString() };
}
