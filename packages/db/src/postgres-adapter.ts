import { postgresResources } from './postgres-resources.js';
import { secretSetSchema, secretScopeSchema } from './secret-contract.js';
import { resourceSchemas } from './module-resources.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase, PostgresGuildStore } from './postgres.js';
import { PostgresLoggingRepository, eventFilter } from './postgres-logging.js';
import { GuildStore } from './index.js';
import type { Operations, StorageDriver, JobRecord, DeliveryClaim, SessionRecord, StorageStatus, SecretRecord } from './contracts.js';
import { HttpError } from '../../core/src/access.js';
const moduleIds = z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)).max(100).transform(ids => [...new Set(ids)]);
type Handlers = { [K in keyof Operations]: (input: Operations[K]['input']) => Promise<Operations[K]['output']> };
function json<T>(data: T): T { return JSON.parse(JSON.stringify(data)) as T; }
export class PostgresAdapter extends PostgresDatabase implements StorageDriver {
  readonly kind = 'postgres' as const;
  scope(guildId: string) { return new GuildStore(this, guildId); }
  async call<K extends keyof Operations>(guild: string, operation: K, input: Operations[K]['input']): Promise<Operations[K]['output']> {
    const core = new PostgresGuildStore(this, guild), logs = new PostgresLoggingRepository(core);
    const handlers: Handlers = {
      ...postgresResources(this, guild),
      secretGet: async input => {
        const { moduleId, name } = secretScopeSchema.parse(input); await core.getModule(moduleId);
        return (await this.query<SecretRecord>('SELECT mode,ciphertext,revision FROM module_secret WHERE guild_id=$1 AND module_id=$2 AND name=$3', [guild, moduleId, name]))[0] ?? null;
      },
      secretSet: async input => {
        const { moduleId, name, expected, mode, ciphertext } = secretSetSchema.parse(input); await core.getModule(moduleId);
        const rows = expected === 0
          ? await this.query<SecretRecord>('INSERT INTO module_secret(guild_id,module_id,name,mode,ciphertext,revision) VALUES($1,$2,$3,$4,$5,1) ON CONFLICT DO NOTHING RETURNING mode,ciphertext,revision', [guild, moduleId, name, mode, ciphertext])
          : await this.query<SecretRecord>('UPDATE module_secret SET mode=$4,ciphertext=$5,revision=revision+1 WHERE guild_id=$1 AND module_id=$2 AND name=$3 AND revision=$6 RETURNING mode,ciphertext,revision', [guild, moduleId, name, mode, ciphertext, expected]);
        if (!rows[0]) throw new HttpError(409, 'REVISION_CONFLICT', 'Secret changed. Refresh its status before trying again.');
        return rows[0];
      },
      workerPoll: async input => {
        const ids = moduleIds.parse(input.moduleIds), jobs = moduleIds.parse(input.jobModuleIds);
        if (input.messageCache) await logs.syncMessageCache(input.messageCache);
        const modules = await Promise.all(ids.map(id => core.getModule(id)));
        await core.heartbeat(input.status, input.details);
        const due = await this.query(`SELECT id FROM core_job WHERE guild_id=$1 AND module_id=ANY($2::text[]) AND expires_at>now() AND due_at<=now() AND (state='pending' OR (state='sending' AND lease_until<now())) LIMIT 1`, [guild, jobs]);
        const deliveries = ids.includes('logging') ? await this.query(`SELECT d.id FROM logging_delivery d JOIN logging_event e ON e.id=d.event_id AND e.guild_id=d.guild_id WHERE d.guild_id=$1 AND e.expires_at>now() AND ((d.state='pending' AND d.next_attempt<=now()) OR (d.state='sending' AND d.lease_until<now())) LIMIT 5`, [guild]) : [];
        return { modules, jobsDue: due.length > 0, deliveriesDue: deliveries.length };
      },
      messageCacheLoad: input => logs.loadMessageCache(input.cursor),
      dashboardSnapshot: async ({ moduleIds: ids }) => {
        const selected = moduleIds.parse(ids);
        return { modules: await Promise.all(selected.map(id => core.getModule(id))), status: await handlers.status({}), events: selected.includes('logging') ? (await logs.list({ limit: 5 })).events : [] };
      },
      deliveryPrepare: async () => {
        const delivery = await handlers.deliveryClaim({});
        return delivery ? { delivery, event: await logs.detail(delivery.event_id), module: await core.getModule('logging') } : null;
      },
      deliveryVerify: async ({ id, claimToken, revision }) => (await this.query(`SELECT d.id FROM logging_delivery d JOIN logging_event e ON e.id=d.event_id AND e.guild_id=d.guild_id JOIN module_config m ON m.guild_id=d.guild_id AND m.module_id='logging'
        WHERE d.guild_id=$1 AND d.id=$2 AND d.claim_token=$3 AND d.state='sending' AND d.lease_until>now() AND e.expires_at>now() AND m.enabled AND m.applied_enabled AND m.applied_revision=$4 AND m.desired_revision=m.applied_revision`, [guild, id, claimToken, revision])).length === 1,

      moduleUpgrade: async input => {
        const { id, expected, fromVersion, toVersion, settings } = resourceSchemas.moduleUpgrade.parse(input);
        if (toVersion <= fromVersion) throw new HttpError(400, 'INVALID_INPUT', 'Settings versions must advance.');
        await this.transaction(async client => {
          const before = (await client.query('SELECT * FROM module_config WHERE guild_id=$1 AND module_id=$2 FOR UPDATE', [guild,id])).rows[0];
          if (!before || before.desired_revision !== expected || before.settings_version !== fromVersion) throw new HttpError(409,'REVISION_CONFLICT','Settings changed during upgrade.');
          await client.query('UPDATE module_config SET settings=$3,settings_version=$4,desired_revision=desired_revision+1,apply_error=NULL WHERE guild_id=$1 AND module_id=$2', [guild,id,JSON.stringify(settings),toVersion]);
          await client.query("INSERT INTO settings_audit(id,guild_id,actor_id,module_id,action,before_value,after_value) VALUES($1,$2,'system:migration',$3,'upgrade',$4,$5)", [randomUUID(),guild,id,JSON.stringify(before.settings),JSON.stringify(settings)]);
        });
        return core.getModule(id);
      },
      ready: async () => { await this.query('SELECT desired_revision FROM module_config LIMIT 0'); await this.query('SELECT revision FROM module_secret LIMIT 0'); return { protocol: 1, trafficProtocol: 1, secretsProtocol: 1, messageCacheProtocol: 1 }; },
      workerVerify: async () => { await this.query('SELECT 1'); return null; },
      initialize: async ({ displayName, modules }) => {
        await this.transaction(async client => {
          await client.query('INSERT INTO guild_config(guild_id,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING', [guild, displayName]);
          for (const m of modules) await client.query('INSERT INTO module_config(guild_id,module_id,settings,applied_settings,settings_version) VALUES($1,$2,$3,$3,$4) ON CONFLICT DO NOTHING', [guild, m.id, JSON.stringify(m.settings), m.settingsVersion]);
        }); return null;
      },
      moduleGet: ({ id }) => core.getModule(id),
      moduleUpdate: ({ id, expected, actor, change }) => core.updateModule(id, expected, actor, change),
      moduleAcknowledge: async ({ id, state }) => { await core.acknowledge(id, state); return null; },
      moduleReject: async ({ id, revision, message }) => { await core.reject(id, revision, message); return null; },
      catalogGet: () => core.catalog(),
      catalogReplace: async ({ channels }) => { await core.replaceCatalog(channels); return null; },
      rolesGet: async () => (await this.query('SELECT data FROM guild_catalog WHERE guild_id=$1 AND kind=\'role\'', [guild])).map(r => r.data),
      heartbeat: async ({ status, details }) => { await core.heartbeat(status, details); return null; },
      incident: async ({ reason, count }) => { await core.incident(reason, count); return null; },
      status: async () => {
        const [health, queue, incidents, count] = await Promise.all([
          this.query<NonNullable<StorageStatus['health']>>(`SELECT heartbeat,status,details FROM runtime_health WHERE guild_id=$1 AND process='bot'`, [guild]),
          this.query<StorageStatus['queue'][number]>('SELECT state,count(*)::int AS count,min(created_at) AS oldest FROM logging_delivery WHERE guild_id=$1 GROUP BY state', [guild]),
          this.query<StorageStatus['incidents'][number]>('SELECT id,started_at,reason,dropped_count FROM coverage_incident WHERE guild_id=$1 ORDER BY started_at DESC LIMIT 10', [guild]),
          this.query<{ count: number }>('SELECT count(*)::int AS count FROM logging_event WHERE guild_id=$1 AND expires_at>now()', [guild])
        ]); return { health: health[0] ?? null, queue, incidents, eventCount: count[0]!.count };
      },
      jobEnqueue: async input => {
        const { moduleId, type, payload, key, options } = resourceSchemas.jobEnqueue.parse(input);
        const delay = options?.delayMs ?? 0, ttl = options?.ttlMs ?? 300000;
        const [row] = await this.query<{id:string}>(`INSERT INTO core_job(id,guild_id,module_id,type,payload,idempotency_key,due_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,now()+($7::bigint*interval '1 millisecond'),now()+($8::bigint*interval '1 millisecond'))
          ON CONFLICT(guild_id,module_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id`, [randomUUID(),guild,moduleId,type,JSON.stringify(payload),key,delay,delay+ttl]);
        return row!.id;
      },
      jobGet: async ({ id }) => {
        const [row] = await this.query<JobRecord>('SELECT id,module_id,payload,attempts,type,state,result,error,expires_at,claim_token FROM core_job WHERE guild_id=$1 AND id=$2', [guild, id]);
        if (!row) throw new HttpError(404, 'NOT_FOUND', 'Job not found.'); return row;
      },
      jobClaim: async ({ moduleIds }) => (await this.query<JobRecord>(`WITH candidate AS (
        SELECT id FROM core_job WHERE guild_id=$1 AND module_id=ANY($3::text[]) AND expires_at>now() AND due_at<=now()
        AND (state='pending' OR (state='sending' AND lease_until<now())) ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE core_job j SET state='sending',lease_until=now()+interval '90 seconds',attempts=attempts+1,claim_token=$2
        FROM candidate c WHERE j.id=c.id RETURNING j.*`, [guild, randomUUID(), moduleIds ?? ['logging']]))[0] ?? null,
      jobFinish: async ({ id, claimToken, error, message }) => {
        await this.query(`UPDATE core_job SET state=$4,result=$5,error=$6,lease_until=NULL,claim_token=NULL WHERE guild_id=$1 AND id=$2 AND claim_token=$3 AND state='sending' AND lease_until>now() AND expires_at>now()`, [guild, id, claimToken, error ? 'failed' : 'completed', message ? JSON.stringify({ message }) : null, error]); return null;
      },
      cleanup: async () => { await core.cleanup(); return null; },
      sessionCreate: async s => {
        await this.query(`INSERT INTO dashboard_session(guild_id,id_hash,user_id,label,tokens,csrf_hash,expires_at,checked_at,access)
          VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days',now(),$7)`, [guild, s.id_hash, s.user_id, s.label, s.tokens, s.csrf_hash, s.access]); return null;
      },
      sessionGet: async ({ hash, touch }) => (await this.query<SessionRecord>(touch
        ? `UPDATE dashboard_session SET last_seen=now() WHERE guild_id=$1 AND id_hash=$2 AND expires_at>now() AND last_seen>now()-interval '24 hours' RETURNING id_hash,user_id,label,tokens,csrf_hash,checked_at,access`
        : `SELECT id_hash,user_id,label,tokens,csrf_hash,checked_at,access FROM dashboard_session WHERE guild_id=$1 AND id_hash=$2 AND expires_at>now() AND last_seen>now()-interval '24 hours'`, [guild, hash]))[0] ?? null,
      sessionRefresh: async ({ hash, tokens, access }) => { await this.query('UPDATE dashboard_session SET tokens=$3,access=$4,checked_at=now() WHERE guild_id=$1 AND id_hash=$2', [guild, hash, tokens, access]); return null; },
      sessionTouch: async ({ hash }) => { await this.query('UPDATE dashboard_session SET last_seen=now() WHERE guild_id=$1 AND id_hash=$2', [guild, hash]); return null; },
      sessionDelete: async ({ hash }) => { await this.query('DELETE FROM dashboard_session WHERE guild_id=$1 AND id_hash=$2', [guild, hash]); return null; },
      oauthCreate: async ({ hash }) => { await this.query(`INSERT INTO oauth_state(guild_id,id_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')`, [guild, hash]); return null; },
      oauthConsume: async ({ hash }) => (await this.query('DELETE FROM oauth_state WHERE guild_id=$1 AND id_hash=$2 AND expires_at>now() RETURNING id_hash', [guild, hash])).length === 1,
      eventCapture: async ({ event, settings, revision }) => { await logs.capture(event, settings, revision); return null; },
      eventList: input => logs.list(eventFilter.parse(input)),
      eventDetail: ({ id }) => logs.detail(id),
      loggingApply: async ({ settings }) => { await logs.apply(settings); return null; },
      loggingCancel: async () => { await logs.cancelPending(); return null; },
      loggingCleanup: async () => { await logs.cleanup(); return null; },
      deliveryClaim: async () => (await this.query<DeliveryClaim>(`WITH candidate AS (
        SELECT d.id FROM logging_delivery d JOIN logging_event e ON e.id=d.event_id AND e.guild_id=d.guild_id
        WHERE d.guild_id=$1 AND e.expires_at>now() AND ((d.state='pending' AND d.next_attempt<=now()) OR (d.state='sending' AND d.lease_until<now()))
        ORDER BY d.next_attempt FOR UPDATE OF d SKIP LOCKED LIMIT 1)
        UPDATE logging_delivery d SET state='sending',lease_until=now()+interval '90 seconds',attempts=attempts+1,claim_token=$2 FROM candidate c WHERE d.id=c.id RETURNING d.*`, [guild, randomUUID()]))[0] ?? null,
      deliveryFinish: async ({ id, claimToken, state, messageId, error, delayMs }) => {
        await this.query(`UPDATE logging_delivery SET state=$4,message_id=COALESCE($5,message_id),last_error=$6,next_attempt=now()+($7::int*interval '1 millisecond'),lease_until=NULL,claim_token=NULL
          WHERE guild_id=$1 AND id=$2 AND claim_token=$3 AND state='sending' AND lease_until>now()`, [guild, id, claimToken, state, messageId ?? null, error ?? null, delayMs ?? 0]); return null;
      },
      deliveryRetry: async ({ id }) => (await this.query(`UPDATE logging_delivery d SET state='pending',next_attempt=now(),last_error=NULL FROM logging_event e
        WHERE d.guild_id=$1 AND d.id=$2 AND d.state IN ('failed','blocked') AND e.id=d.event_id AND e.guild_id=d.guild_id AND e.expires_at>now() RETURNING d.id`, [guild, id])).length === 1,
      leaseAcquire: async ({ owner }) => (await this.query(`INSERT INTO worker_lease(guild_id,owner,expires_at) VALUES($1,$2,now()+interval '60 seconds')
        ON CONFLICT(guild_id) DO UPDATE SET owner=$2,expires_at=now()+interval '60 seconds' WHERE worker_lease.expires_at<now() RETURNING owner`, [guild, owner])).length === 1,
      leaseRenew: async ({ owner }) => (await this.query(`UPDATE worker_lease SET expires_at=now()+interval '60 seconds' WHERE guild_id=$1 AND owner=$2 AND expires_at>now() RETURNING owner`, [guild, owner])).length === 1,
      leaseRelease: async ({ owner }) => { await this.query('DELETE FROM worker_lease WHERE guild_id=$1 AND owner=$2', [guild, owner]); return null; }
    };
    return json(await handlers[operation](input));
  }
}
