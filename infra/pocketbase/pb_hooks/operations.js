/* Named storage operations only. This module never accepts SQL from callers. */
const day = 86400000;
function fail(status, code, message) { const error = new Error(message); error.omoStatus = status; error.omoCode = code; throw error; }
function uuid() { const h = n => $security.randomStringWithAlphabet(n, '0123456789abcdef'); return `${h(8)}-${h(4)}-4${h(3)}-8${h(3)}-${h(12)}`; }
function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_INPUT', 'Expected an object.'); return value; }
function text(value, max = 200) { if (typeof value !== 'string' || !value.length || value.length > max) fail(400, 'INVALID_INPUT', 'Invalid text field.'); return value; }
function integer(value, min, max) { if (!Number.isInteger(value) || value < min || value > max) fail(400, 'INVALID_INPUT', 'Invalid integer field.'); return value; }
function fields(map) { return `json_object(${Object.entries(map).map(([name, column]) => `'${name}',${column}`).join(',')}) AS doc`; }
const moduleFields = fields({ moduleId: 'module_id', settingsVersion: 'settings_version', appliedSettingsVersion: 'applied_settings_version', enabled: 'enabled', appliedEnabled: 'applied_enabled', settings: 'json(settings)', appliedSettings: 'json(applied_settings)', desiredRevision: 'desired_revision', appliedRevision: 'applied_revision', applyError: 'apply_error' });
const eventFields = fields({ id: 'e.id', type: 'e.type', subjectId: 'e.subject_id', subjectLabel: 'e.subject_label', channelId: 'e.channel_id', parentId: 'e.parent_id', observedAt: 'e.observed_at', before: 'json(e.before_value)', after: 'json(e.after_value)', actorId: 'e.actor_id', reason: 'e.reason', attribution: 'e.attribution', configRevision: 'e.config_revision', expiresAt: 'e.expires_at', deliveryState: 'd.state', messageId: 'd.message_id', destinationId: 'd.destination_id' });
const jobFields = fields({ id: 'id', module_id: 'module_id', payload: 'json(payload)', attempts: 'attempts', type: 'type', state: 'state', result: 'json(result)', error: 'error', expires_at: 'expires_at', claim_token: 'claim_token' });
const deliveryFields = fields({ id: 'id', event_id: 'event_id', destination_id: 'destination_id', marker: 'marker', attempts: 'attempts', created_at: 'created_at', claim_token: 'claim_token' });
const workerOperations = new Set(['workerPoll', 'messageCacheLoad', 'deliveryPrepare', 'deliveryVerify', 'workerVerify', 'moduleAcknowledge', 'moduleReject', 'heartbeat', 'eventCapture', 'jobClaim', 'jobFinish', 'deliveryClaim', 'deliveryFinish', 'loggingApply', 'loggingCancel']);
const readOperations = new Set(['ready', 'secretGet', 'moduleGet', 'recordGet', 'recordList', 'catalogGet', 'rolesGet', 'status', 'jobGet', 'eventList', 'eventDetail']);
function settings(input) {
  object(input); integer(input.metadataRetentionDays, 7, 90);
  if (input.destinationId !== null && !/^\d{17,20}$/.test(input.destinationId)) fail(400, 'INVALID_INPUT', 'Invalid destination.');
  if (!/^#[a-fA-F0-9]{6}$/.test(input.accentColor)) fail(400, 'INVALID_INPUT', 'Invalid accent.');
  for (const key of ['excludedChannelIds', 'excludedCategoryIds']) if (!Array.isArray(input[key]) || input[key].length > 100 || input[key].some(id => !/^\d{17,20}$/.test(id))) fail(400, 'INVALID_INPUT', 'Invalid exclusions.');
  object(input.events); for (const type of ['channel.created', 'channel.updated', 'channel.deleted']) if (typeof input.events[type] !== 'boolean') fail(400, 'INVALID_INPUT', 'Invalid event settings.');
  return input;
}
function excluded(event, config) { return config.excludedChannelIds.includes(event.subjectId) || config.excludedCategoryIds.includes(event.subjectId) || config.excludedCategoryIds.includes(event.parentId); }
function execute(app, guild, operation, input, owner) {
  object(input);
  let result = null;
  const run = tx => {
    const now = Date.now(), params = { guild, now };
    const rows = (sql, values = {}) => { const out = arrayOf(new DynamicModel({ doc: '' })); tx.db().newQuery(sql).bind({ ...params, ...values }).all(out); return Array.from(out).map(row => JSON.parse(row.doc)); };
    const write = (sql, values = {}) => tx.db().newQuery(sql).bind({ ...params, ...values }).execute().rowsAffected();
    const one = (sql, values) => rows(sql, values)[0] || null;
    const required = value => { if (!value) fail(404, 'NOT_FOUND', 'Record not found or expired.'); return value; };
    const getModule = id => { const m = required(one(`SELECT ${moduleFields} FROM omo_module WHERE guild_id={:guild} AND module_id={:id}`, { id })); m.enabled = !!m.enabled; m.appliedEnabled = !!m.appliedEnabled; return m; };
    const mapEvent = e => ({ ...e, observedAt: iso(e.observedAt), expiresAt: iso(e.expiresAt) });
    if (workerOperations.has(operation)) {
      if (!owner || !one(`SELECT json_object('owner',owner) AS doc FROM omo_lease WHERE guild_id={:guild} AND owner={:owner} AND expires_at>{:now}`, { owner })) fail(409, 'LEASE_LOST', 'Worker ownership was lost.');
    }
    const recordFields = fields({ key: 'key', value: 'json(value)', revision: 'revision', updatedAt: 'updated_at' });
    const boundedJson = value => { const data = JSON.stringify(value); if (data === undefined || encodeURIComponent(data).replace(/%[0-9A-F]{2}/g, 'x').length > 32768) fail(400, 'INVALID_INPUT', 'JSON exceeds 32 KiB.'); return data; };
    const recordScope = () => { const module = text(input.moduleId,32); if (!/^[a-z][a-z0-9-]{0,31}$/.test(module)) fail(400,'INVALID_INPUT','Invalid module ID.'); getModule(module); return module; };
    const mapRecord = row => row ? { ...row, updatedAt: iso(row.updatedAt) } : null;
    const recordGet = (module,key) => mapRecord(one(`SELECT ${recordFields} FROM omo_module_record WHERE guild_id={:guild} AND module_id={:module} AND key={:key} AND (expires_at IS NULL OR expires_at>{:now})`, {module,key}));
    const moduleIds = value => { if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(id))) fail(400, 'INVALID_INPUT', 'Invalid module IDs.'); return [...new Set(value)]; };
    const messageCache = require(`${__hooks}/message-cache.js`).create(write, now);
    const actions = {
      secretGet() {
        getModule(text(input.moduleId, 32));
        const name = text(input.name, 64); if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) fail(400, 'INVALID_INPUT', 'Invalid secret name.');
        return one(`SELECT json_object('mode',mode,'ciphertext',ciphertext,'revision',revision) AS doc FROM omo_module_secret WHERE guild_id={:guild} AND module_id={:module} AND name={:name}`, { module: input.moduleId, name });
      },
      secretSet() {
        const previous = actions.secretGet(), expected = integer(input.expected, 0, 2147483646);
        if ((previous ? previous.revision : 0) !== expected) fail(409, 'REVISION_CONFLICT', 'Secret changed. Refresh its status.');
        if (!['stored','disabled','environment'].includes(input.mode) || (input.mode === 'stored' ? typeof input.ciphertext !== 'string' || !/^[A-Za-z0-9_-]{32,40000}$/.test(input.ciphertext) : input.ciphertext !== null)) fail(400, 'INVALID_INPUT', 'Invalid encrypted secret.');
        write(`INSERT INTO omo_module_secret(guild_id,module_id,name,mode,ciphertext,revision) VALUES({:guild},{:module},{:name},{:mode},{:ciphertext},{:revision}) ON CONFLICT(guild_id,module_id,name) DO UPDATE SET mode={:mode},ciphertext={:ciphertext},revision={:revision}`, { module: input.moduleId, name: input.name, mode: input.mode, ciphertext: input.ciphertext, revision: expected + 1 });
        return actions.secretGet();
      },
      workerPoll() {
        const ids = moduleIds(input.moduleIds), jobs = moduleIds(input.jobModuleIds);
        if (input.messageCache) {
          const module = getModule('logging');
          messageCache.sync(input.messageCache, module.enabled && module.appliedEnabled ? settings(module.appliedSettings) : null);
        }
        const modules = ids.map(getModule);
        actions.heartbeat();
        const jobsDue = !!one(`SELECT json_object('id',id) AS doc FROM omo_job WHERE guild_id={:guild} AND module_id IN (SELECT value FROM json_each({:modules})) AND expires_at>{:now} AND due_at<={:now} AND (state='pending' OR (state='sending' AND lease_until<{:now})) LIMIT 1`, { modules: JSON.stringify(jobs) });
        const deliveriesDue = ids.includes('logging') ? rows(`SELECT json_object('id',d.id) AS doc FROM omo_delivery d JOIN omo_event e ON e.id=d.event_id AND e.guild_id=d.guild_id WHERE d.guild_id={:guild} AND e.expires_at>{:now} AND ((d.state='pending' AND d.next_attempt<={:now}) OR (d.state='sending' AND d.lease_until<{:now})) LIMIT 5`).length : 0;
        return { modules, jobsDue, deliveriesDue };
      },
      messageCacheLoad() {
        if (typeof input.cursor !== 'string' || !/^(message-cache:\d{17,20})?$/.test(input.cursor)) fail(400, 'INVALID_INPUT', 'Invalid cache cursor.');
        const records = rows(`SELECT ${recordFields} FROM omo_module_record WHERE guild_id={:guild} AND module_id='logging' AND key LIKE 'message-cache:%' AND key>{:cursor} AND expires_at>{:now} ORDER BY key LIMIT 501`, { cursor: input.cursor }).map(mapRecord);
        const more = records.length > 500; if (more) records.pop();
        return { records, nextCursor: more ? records[records.length - 1].key : null };
      },
      dashboardSnapshot() {
        const ids = moduleIds(input.moduleIds), modules = ids.map(getModule);
        const events = ids.includes('logging') ? rows(`SELECT ${eventFields} FROM omo_event e LEFT JOIN omo_delivery d ON d.event_id=e.id AND d.guild_id=e.guild_id WHERE e.guild_id={:guild} AND e.expires_at>{:now} ORDER BY e.observed_at DESC,e.id DESC LIMIT 5`).map(mapEvent) : [];
        return { modules, status: actions.status(), events };
      },
      deliveryPrepare() {
        const delivery = actions.deliveryClaim();
        if (!delivery) return null;
        const event = mapEvent(required(one(`SELECT ${eventFields} FROM omo_event e LEFT JOIN omo_delivery d ON d.event_id=e.id AND d.guild_id=e.guild_id WHERE e.guild_id={:guild} AND e.id={:id} AND e.expires_at>{:now}`, { id: delivery.event_id })));
        return { delivery, event, module: getModule('logging') };
      },
      deliveryVerify() {
        return !!one(`SELECT json_object('id',d.id) AS doc FROM omo_delivery d JOIN omo_event e ON e.id=d.event_id AND e.guild_id=d.guild_id JOIN omo_module m ON m.guild_id=d.guild_id AND m.module_id='logging'
          WHERE d.guild_id={:guild} AND d.id={:id} AND d.claim_token={:token} AND d.state='sending' AND d.lease_until>{:now} AND e.expires_at>{:now} AND m.enabled=1 AND m.applied_enabled=1 AND m.applied_revision={:revision} AND m.desired_revision=m.applied_revision`, { id: text(input.id), token: text(input.claimToken), revision: integer(input.revision, 1, 2147483647) });
      },
      recordGet() { return recordGet(recordScope(),text(input.key,160)); },
      recordList() {
        const module = recordScope(), limit = integer(input.limit,1,100);
        if (typeof input.prefix !== 'string' || input.prefix.length > 160 || typeof input.cursor !== 'string' || input.cursor.length > 160) fail(400,'INVALID_INPUT','Invalid record cursor.');
        const records = rows(`SELECT ${recordFields} FROM omo_module_record WHERE guild_id={:guild} AND module_id={:module} AND substr(key,1,length({:prefix}))={:prefix} AND key>{:cursor} AND (expires_at IS NULL OR expires_at>{:now}) ORDER BY key LIMIT {:limit}`, {module,prefix:input.prefix,cursor:input.cursor,limit:limit+1}).map(mapRecord);
        const more = records.length > limit; if (more) records.pop(); return {records,nextCursor:more ? records[records.length-1].key : null};
      },
      recordPut() {
        const module=recordScope(),key=text(input.key,160),value=boundedJson(input.value),expected=integer(input.expected,0,2147483646);
        const expiry=input.ttlMs === undefined ? null : now+integer(input.ttlMs,1000,90*day);
        const changed=expected===0 ? write(`INSERT INTO omo_module_record(guild_id,module_id,key,value,updated_at,expires_at) VALUES({:guild},{:module},{:key},{:value},{:now},{:expiry}) ON CONFLICT(guild_id,module_id,key) DO UPDATE SET value={:value},revision=revision+1,updated_at={:now},expires_at={:expiry} WHERE omo_module_record.expires_at<={:now}`,{module,key,value,expiry})
          : write(`UPDATE omo_module_record SET value={:value},revision=revision+1,updated_at={:now},expires_at={:expiry} WHERE guild_id={:guild} AND module_id={:module} AND key={:key} AND revision={:expected} AND (expires_at IS NULL OR expires_at>{:now})`,{module,key,value,expiry,expected});
        if (changed!==1) fail(409,'REVISION_CONFLICT','Record changed. Reload before saving.'); return recordGet(module,key);
      },
      recordDelete() {
        const module=recordScope(),key=text(input.key,160),expected=integer(input.expected,1,2147483646);
        if (write(`DELETE FROM omo_module_record WHERE guild_id={:guild} AND module_id={:module} AND key={:key} AND revision={:expected} AND (expires_at IS NULL OR expires_at>{:now})`,{module,key,expected})!==1) fail(409,'REVISION_CONFLICT','Record changed. Reload before deleting.'); return true;
      },
      moduleUpgrade() {
        const id=text(input.id,32),before=getModule(id),from=integer(input.fromVersion,1,10000),to=integer(input.toVersion,1,10000);
        if (to<=from) fail(400,'INVALID_INPUT','Settings versions must advance.');
        if (before.desiredRevision!==input.expected || before.settingsVersion!==from) fail(409,'REVISION_CONFLICT','Settings changed during upgrade.');
        const settings=boundedJson(input.settings);
        write('UPDATE omo_module SET settings={:settings},settings_version={:to},desired_revision=desired_revision+1,apply_error=NULL WHERE guild_id={:guild} AND module_id={:id}',{id,settings,to});
        write(`INSERT INTO omo_settings_audit(id,guild_id,actor_id,module_id,before_value,after_value,created_at) VALUES({:key},{:guild},'system:migration',{:id},{:before},{:after},{:now})`,{key:uuid(),id,before:JSON.stringify(before.settings),after:settings}); return getModule(id);
      },
      workerVerify() { return null; },
      ready() { const row = one(`SELECT json_object('version',version) AS doc FROM omo_schema`); if (!row || row.version !== 1) throw new Error('Schema mismatch'); rows(`SELECT json_object('revision',revision) AS doc FROM omo_module_secret LIMIT 0`); return { protocol: 1, trafficProtocol: 1, secretsProtocol: 1, messageCacheProtocol: 1 }; },
      initialize() {
        text(input.displayName, 60); if (!Array.isArray(input.modules) || input.modules.length > 100) fail(400, 'INVALID_INPUT', 'Invalid modules.');
        write('INSERT INTO omo_guild(guild_id,display_name) VALUES({:guild},{:name}) ON CONFLICT DO NOTHING', { name: input.displayName });
        for (const m of input.modules) { text(m.id, 32); integer(m.settingsVersion, 1, 10000); write('INSERT INTO omo_module(guild_id,module_id,settings,applied_settings,settings_version) VALUES({:guild},{:id},{:settings},{:settings},{:version}) ON CONFLICT DO NOTHING', { id: m.id, settings: JSON.stringify(m.settings), version: m.settingsVersion }); }
        return null;
      },
      moduleGet() { return getModule(text(input.id, 32)); },
      moduleUpdate() {
        const id = text(input.id, 32), before = getModule(id); integer(input.expected, 1, 2147483646); text(input.actor, 100); object(input.change);
        if (before.desiredRevision !== input.expected) fail(409, 'REVISION_CONFLICT', 'Settings changed in another session. Reload before saving.');
        const next = { settings: input.change.settings === undefined ? before.settings : input.change.settings, enabled: input.change.enabled === undefined ? before.enabled : input.change.enabled };
        if (typeof next.enabled !== 'boolean') fail(400, 'INVALID_INPUT', 'Invalid enablement.');
        if (id === 'logging') settings(next.settings);
        write('UPDATE omo_module SET settings={:settings},enabled={:enabled},desired_revision=desired_revision+1,apply_error=NULL WHERE guild_id={:guild} AND module_id={:id}', { id, settings: JSON.stringify(next.settings), enabled: next.enabled ? 1 : 0 });
        write('INSERT INTO omo_settings_audit(id,guild_id,actor_id,module_id,before_value,after_value,created_at) VALUES({:key},{:guild},{:actor},{:id},{:before},{:after},{:now})', { key: uuid(), actor: input.actor, id, before: JSON.stringify({ settings: before.settings, enabled: before.enabled }), after: JSON.stringify(next) });
        return getModule(id);
      },
      moduleAcknowledge() {
        object(input.state); integer(input.state.desiredRevision, 1, 2147483647);
        write('UPDATE omo_module SET applied_revision={:revision},applied_enabled={:enabled},applied_settings={:settings},applied_settings_version={:version},apply_error=CASE WHEN desired_revision={:revision} THEN NULL ELSE apply_error END WHERE guild_id={:guild} AND module_id={:id}', { id: text(input.id, 32), revision: input.state.desiredRevision, enabled: input.state.enabled ? 1 : 0, settings: JSON.stringify(input.state.settings), version: integer(input.state.settingsVersion || 1, 1, 10000) }); return null;
      },
      moduleReject() { write('UPDATE omo_module SET apply_error={:error} WHERE guild_id={:guild} AND module_id={:id} AND desired_revision={:revision}', { id: text(input.id, 32), revision: integer(input.revision, 1, 2147483647), error: text(input.message, 300) }); return null; },
      catalogGet() { return rows('SELECT data AS doc FROM omo_catalog WHERE guild_id={:guild} AND kind=\'channel\' ORDER BY json_extract(data,\'$.name\')'); },
      rolesGet() { return rows('SELECT data AS doc FROM omo_catalog WHERE guild_id={:guild} AND kind=\'role\''); },
      catalogReplace() {
        if (!Array.isArray(input.channels) || input.channels.length > 1000) fail(400, 'INVALID_INPUT', 'Invalid catalog.');
        write('DELETE FROM omo_catalog WHERE guild_id={:guild} AND kind=\'channel\'');
        for (const c of input.channels) write('INSERT INTO omo_catalog(guild_id,kind,id,data) VALUES({:guild},\'channel\',{:id},{:data})', { id: text(c.id), data: JSON.stringify(c) }); return null;
      },
      heartbeat() { write('INSERT INTO omo_health(guild_id,heartbeat,status,details) VALUES({:guild},{:now},{:status},{:details}) ON CONFLICT(guild_id) DO UPDATE SET heartbeat={:now},status={:status},details={:details}', { status: text(input.status, 32), details: JSON.stringify(object(input.details)) }); return null; },
      incident() { write('INSERT INTO omo_incident(id,guild_id,started_at,reason,dropped_count) VALUES({:id},{:guild},{:now},{:reason},{:count})', { id: uuid(), reason: text(input.reason, 500), count: input.count === null ? null : integer(input.count, 0, 2147483647) }); return null; },
      status() {
        const health = one(`SELECT ${fields({ heartbeat: 'heartbeat', status: 'status', details: 'json(details)' })} FROM omo_health WHERE guild_id={:guild}`);
        if (health) health.heartbeat = iso(health.heartbeat);
        const queue = rows(`SELECT ${fields({ state: 'state', count: 'count(*)', oldest: 'min(created_at)' })} FROM omo_delivery WHERE guild_id={:guild} GROUP BY state`).map(q => ({ ...q, oldest: iso(q.oldest) }));
        const incidents = rows(`SELECT ${fields({ id: 'id', started_at: 'started_at', reason: 'reason', dropped_count: 'dropped_count' })} FROM omo_incident WHERE guild_id={:guild} ORDER BY started_at DESC LIMIT 10`).map(i => ({ ...i, started_at: iso(i.started_at) }));
        return { health, queue, incidents, eventCount: one(`SELECT json_object('count',count(*)) AS doc FROM omo_event WHERE guild_id={:guild} AND expires_at>{:now}`).count };
      },
      jobEnqueue() {
        const id = uuid(), key = text(input.key, 100), module = recordScope(), type = text(input.type, 50);
        if (!/^[a-z][a-z0-9.-]{0,49}$/.test(type)) fail(400,'INVALID_INPUT','Invalid job type.');
        const options=input.options===undefined ? {} : object(input.options),delay=integer(options.delayMs===undefined ? 0 : options.delayMs,0,30*day),ttl=integer(options.ttlMs===undefined ? 300000 : options.ttlMs,1000,90*day);
        write('INSERT INTO omo_job(id,guild_id,module_id,type,payload,idempotency_key,due_at,expires_at,created_at) VALUES({:id},{:guild},{:module},{:type},{:payload},{:key},{:due},{:expiry},{:now}) ON CONFLICT(guild_id,module_id,idempotency_key) DO NOTHING', { id, module, type, payload: boundedJson(input.payload), key, due: now+delay, expiry: now+delay+ttl });
        return one('SELECT json_object(\'id\',id) AS doc FROM omo_job WHERE guild_id={:guild} AND module_id={:module} AND idempotency_key={:key}', { module, key }).id;
      },
      jobGet() { const job = required(one(`SELECT ${jobFields} FROM omo_job WHERE guild_id={:guild} AND id={:id}`, { id: text(input.id) })); job.expires_at = iso(job.expires_at); return job; },
      jobClaim() {
        const modules=input.moduleIds || ['logging']; if (!Array.isArray(modules) || modules.length>100 || modules.some(id => typeof id!=='string' || !/^[a-z][a-z0-9-]{0,31}$/.test(id))) fail(400,'INVALID_INPUT','Invalid job modules.');
        const job = one(`SELECT ${jobFields} FROM omo_job WHERE guild_id={:guild} AND module_id IN (SELECT value FROM json_each({:modules})) AND expires_at>{:now} AND due_at<={:now} AND (state='pending' OR (state='sending' AND lease_until<{:now})) ORDER BY due_at LIMIT 1`,{modules:JSON.stringify(modules)});
        if (!job) return null;
        const token = uuid(); write(`UPDATE omo_job SET state='sending',lease_until={:lease},attempts=attempts+1,claim_token={:token} WHERE guild_id={:guild} AND id={:id}`, { id: job.id, lease: now + 90000, token });
        return { ...job, attempts: job.attempts+1, state: 'sending', claim_token: token, expires_at: iso(job.expires_at) };
      },
      jobFinish() { write(`UPDATE omo_job SET state={:state},result={:result},error={:error},lease_until=NULL,claim_token=NULL WHERE guild_id={:guild} AND id={:id} AND claim_token={:token} AND state='sending' AND lease_until>{:now} AND expires_at>{:now}`, { id: text(input.id), token: text(input.claimToken), state: input.error ? 'failed' : 'completed', result: input.message ? JSON.stringify({ message: input.message }) : null, error: input.error }); return null; },
      cleanup() {
        write('DELETE FROM omo_module_record WHERE guild_id={:guild} AND expires_at<={:now}');
        write('DELETE FROM omo_settings_audit WHERE guild_id={:guild} AND created_at<{:cutoff}', { cutoff: now - 90 * day });
        write(`UPDATE omo_job SET state='expired',lease_until=NULL,claim_token=NULL WHERE guild_id={:guild} AND expires_at<={:now} AND state IN ('pending','sending')`);
        write("DELETE FROM omo_job WHERE guild_id={:guild} AND created_at<{:cutoff} AND state NOT IN ('pending','sending')", { cutoff: now - 7 * day });
        write('DELETE FROM omo_incident WHERE guild_id={:guild} AND started_at<{:cutoff}', { cutoff: now - 30 * day });
        write('DELETE FROM omo_session WHERE guild_id={:guild} AND (expires_at<={:now} OR last_seen<{:cutoff})', { cutoff: now - day });
        write('DELETE FROM omo_oauth WHERE guild_id={:guild} AND expires_at<={:now}'); return null;
      },
      sessionCreate() {
        write('INSERT INTO omo_session(guild_id,id_hash,user_id,label,tokens,csrf_hash,expires_at,last_seen,checked_at,access) VALUES({:guild},{:hash},{:user},{:label},{:tokens},{:csrf},{:expiry},{:now},{:now},{:access})', { hash: text(input.id_hash), user: text(input.user_id), label: text(input.label), tokens: text(input.tokens, 20000), csrf: text(input.csrf_hash), expiry: now + 7 * day, access: input.access }); return null;
      },
      sessionGet() {
        const session = one(`SELECT ${fields({ id_hash: 'id_hash', user_id: 'user_id', label: 'label', tokens: 'tokens', csrf_hash: 'csrf_hash', checked_at: 'checked_at', access: 'access' })} FROM omo_session WHERE guild_id={:guild} AND id_hash={:hash} AND expires_at>{:now} AND last_seen>{:cutoff}`, { hash: text(input.hash), cutoff: now - day });
        if (session) { session.checked_at = iso(session.checked_at); if (input.touch === true) actions.sessionTouch(); } return session;
      },
      sessionRefresh() { write('UPDATE omo_session SET tokens={:tokens},access={:access},checked_at={:now} WHERE guild_id={:guild} AND id_hash={:hash}', { hash: text(input.hash), tokens: text(input.tokens, 20000), access: input.access }); return null; },
      sessionTouch() { write('UPDATE omo_session SET last_seen={:now} WHERE guild_id={:guild} AND id_hash={:hash}', { hash: text(input.hash) }); return null; },
      sessionDelete() { write('DELETE FROM omo_session WHERE guild_id={:guild} AND id_hash={:hash}', { hash: text(input.hash) }); return null; },
      oauthCreate() { write('INSERT INTO omo_oauth(guild_id,id_hash,expires_at) VALUES({:guild},{:hash},{:expiry})', { hash: text(input.hash), expiry: now + 600000 }); return null; },
      oauthConsume() { return write('DELETE FROM omo_oauth WHERE guild_id={:guild} AND id_hash={:hash} AND expires_at>{:now}', { hash: text(input.hash) }) === 1; },
      eventCapture() {
        const event = object(input.event), config = settings(input.settings); integer(input.revision, 1, 2147483647);
        if (event.guildId !== guild) return null;
        if (excluded(event, config) || (event.type !== 'logging.test' && !config.events[event.type])) return null;
        if (event.type === 'channel.updated' && JSON.stringify(event.before) === JSON.stringify(event.after)) return null;
        const observed = Date.parse(event.observedAt); if (!Number.isFinite(observed)) fail(400, 'INVALID_INPUT', 'Invalid observation time.');
        const id = uuid(), inserted = write(`INSERT INTO omo_event(id,guild_id,type,source_key,subject_id,subject_label,channel_id,parent_id,observed_at,before_value,after_value,config_revision,expires_at)
          VALUES({:id},{:guild},{:type},{:source},{:subject},{:label},{:channel},{:parent},{:observed},{:before},{:after},{:revision},{:expiry}) ON CONFLICT(guild_id,source_key) DO NOTHING`,
          { id, type: text(event.type, 50), source: text(event.sourceKey, 200), subject: text(event.subjectId, 20), label: text(event.label, 200), channel: event.channelId, parent: event.parentId, observed, before: event.before === null ? null : JSON.stringify(event.before), after: event.after === null ? null : JSON.stringify(event.after), revision: input.revision, expiry: observed + config.metadataRetentionDays * day });
        if (inserted && config.destinationId) write('INSERT INTO omo_delivery(id,guild_id,event_id,destination_id,marker,next_attempt,created_at) VALUES({:id},{:guild},{:event},{:destination},{:marker},{:now},{:now})', { id: uuid(), event: id, destination: config.destinationId, marker: $security.sha256(`${id}:${config.destinationId}`).slice(0, 24) });
        return null;
      },
      eventList() {
        const limit = integer(input.limit, 1, 100);
        let cursor = null;
        if (input.cursor) { try { cursor = JSON.parse(input.cursor); if (!Number.isFinite(Date.parse(cursor.time)) || !/^[a-f0-9-]{36}$/.test(cursor.id)) throw new Error('bad cursor'); } catch { fail(400, 'INVALID_INPUT', 'Invalid event cursor.'); } }
        const events = rows(`SELECT ${eventFields} FROM omo_event e LEFT JOIN omo_delivery d ON d.event_id=e.id AND d.guild_id=e.guild_id WHERE e.guild_id={:guild} AND e.expires_at>{:now}
          AND ({:type} IS NULL OR e.type={:type}) AND ({:subject} IS NULL OR e.subject_id={:subject})
          AND ({:cursor} IS NULL OR e.observed_at<{:cursor} OR (e.observed_at={:cursor} AND e.id<{:id})) ORDER BY e.observed_at DESC,e.id DESC LIMIT {:limit}`,
          { type: input.type || null, subject: input.subject || null, cursor: cursor ? Date.parse(cursor.time) : null, id: cursor ? cursor.id : null, limit: limit + 1 }).map(mapEvent);
        const more = events.length > limit; if (more) events.pop(); const last = events[events.length - 1];
        return { events, nextCursor: more && last ? JSON.stringify({ time: last.observedAt, id: last.id }) : null };
      },
      eventDetail() { return mapEvent(required(one(`SELECT ${eventFields} FROM omo_event e LEFT JOIN omo_delivery d ON d.event_id=e.id AND d.guild_id=e.guild_id WHERE e.guild_id={:guild} AND e.id={:id} AND e.expires_at>{:now}`, { id: text(input.id) }))); },
      loggingApply() {
        const config = settings(input.settings);
        messageCache.prune(config);
        write('UPDATE omo_event SET expires_at=min(expires_at,observed_at+{:retention}) WHERE guild_id={:guild}', { retention: config.metadataRetentionDays * day });
        write(`UPDATE omo_delivery SET state='cancelled',lease_until=NULL,claim_token=NULL WHERE guild_id={:guild} AND state IN ('pending','blocked','failed','sending') AND event_id IN
          (SELECT id FROM omo_event WHERE guild_id={:guild} AND (expires_at<={:now} OR subject_id IN (SELECT value FROM json_each({:channels})) OR parent_id IN (SELECT value FROM json_each({:categories})) OR subject_id IN (SELECT value FROM json_each({:categories})) OR {:destination} IS NULL))`, { channels: JSON.stringify(config.excludedChannelIds), categories: JSON.stringify(config.excludedCategoryIds), destination: config.destinationId });
        // A route change is a new unsent destination. Keep sent history untouched.
        if (config.destinationId) {
          const pending = rows(`SELECT json_object('id',id,'event',event_id,'destination',destination_id) AS doc FROM omo_delivery WHERE guild_id={:guild} AND state IN ('pending','blocked','failed')`);
          for (const d of pending) write(`UPDATE omo_delivery SET destination_id={:destination},state='pending',next_attempt={:now},last_error=NULL,marker={:marker} WHERE guild_id={:guild} AND id={:id}`, { destination: config.destinationId, id: d.id, marker: $security.sha256(`${d.event}:${config.destinationId}`).slice(0, 24) });
        } return null;
      },
      loggingCancel() { messageCache.prune(null); write(`UPDATE omo_delivery SET state='cancelled',lease_until=NULL,claim_token=NULL WHERE guild_id={:guild} AND state IN ('pending','blocked','failed','sending')`); return null; },
      loggingCleanup() { write('DELETE FROM omo_event WHERE guild_id={:guild} AND expires_at<={:now}'); return null; },
      deliveryClaim() {
        const delivery = one(`SELECT ${deliveryFields} FROM omo_delivery WHERE guild_id={:guild} AND event_id IN (SELECT id FROM omo_event WHERE guild_id={:guild} AND expires_at>{:now})
          AND ((state='pending' AND next_attempt<={:now}) OR (state='sending' AND lease_until<{:now})) ORDER BY next_attempt LIMIT 1`);
        if (!delivery) return null;
        const token = uuid(); write(`UPDATE omo_delivery SET state='sending',lease_until={:lease},attempts=attempts+1,claim_token={:token} WHERE guild_id={:guild} AND id={:id}`, { id: delivery.id, lease: now + 90000, token });
        return { ...delivery, claim_token: token, attempts: delivery.attempts + 1, created_at: iso(delivery.created_at) };
      },
      deliveryFinish() {
        if (!['sent', 'cancelled', 'blocked', 'failed', 'pending'].includes(input.state)) fail(400, 'INVALID_INPUT', 'Invalid delivery state.');
        write(`UPDATE omo_delivery SET state={:state},message_id=coalesce({:message},message_id),last_error={:error},next_attempt={:next},lease_until=NULL,claim_token=NULL WHERE guild_id={:guild} AND id={:id} AND claim_token={:token} AND state='sending' AND lease_until>{:now}`, { id: text(input.id), token: text(input.claimToken), state: input.state, message: input.messageId || null, error: input.error || null, next: now + integer(input.delayMs || 0, 0, 600000) }); return null;
      },
      deliveryRetry() { return write(`UPDATE omo_delivery SET state='pending',next_attempt={:now},last_error=NULL WHERE guild_id={:guild} AND id={:id} AND state IN ('failed','blocked') AND event_id IN (SELECT id FROM omo_event WHERE guild_id={:guild} AND expires_at>{:now})`, { id: text(input.id) }) === 1; },
      leaseAcquire() { return write('INSERT INTO omo_lease(guild_id,owner,expires_at) VALUES({:guild},{:owner},{:expiry}) ON CONFLICT(guild_id) DO UPDATE SET owner={:owner},expires_at={:expiry} WHERE omo_lease.expires_at<={:now}', { owner: text(input.owner), expiry: now + 60000 }) === 1; },
      leaseRenew() { return write('UPDATE omo_lease SET expires_at={:expiry} WHERE guild_id={:guild} AND owner={:owner} AND expires_at>{:now}', { owner: text(input.owner), expiry: now + 60000 }) === 1; },
      leaseRelease() { write('DELETE FROM omo_lease WHERE guild_id={:guild} AND owner={:owner}', { owner: text(input.owner) }); return null; }
    };
    if (!Object.prototype.hasOwnProperty.call(actions, operation)) fail(404, 'NOT_FOUND', 'Unknown storage operation.');
    result = actions[operation]();
  };
  if (readOperations.has(operation)) run(app); else app.runInTransaction(run);
  return result;
}
module.exports = { execute };
