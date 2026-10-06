/* Bounded logging snapshots, using the existing module-record table. */
const prefix = 'message-cache:', ttl = 86400000, limit = 5000;
function invalid() { const error = new Error('Invalid message cache batch.'); error.omoStatus = 400; error.omoCode = 'INVALID_INPUT'; throw error; }
function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function id(value) { return typeof value === 'string' && /^\d{17,20}$/.test(value); }
function nullableId(value) { return value === null || id(value); }
function string(value, max) { return typeof value === 'string' && value.length <= max; }
function allowed(entry, config) {
  return config && (config.events['message.edited'] || config.events['message.deleted'])
    && entry.channelId !== config.destinationId
    && ![entry.id, entry.channelId, entry.containerId].some(id => config.excludedChannelIds.includes(id))
    && ![entry.id, entry.parentId].some(id => config.excludedCategoryIds.includes(id));
}
function validate(batch) {
  shape(batch, ['upserts', 'deletes']);
  if (!Array.isArray(batch.upserts) || batch.upserts.length > 100 || !Array.isArray(batch.deletes) || batch.deletes.length > limit || batch.deletes.some(value => !id(value))) invalid();
  if (encodeURIComponent(JSON.stringify(batch)).replace(/%[0-9A-F]{2}/g, 'x').length > 512 * 1024) invalid();
  const seen = new Set();
  for (const entry of batch.upserts) {
    shape(entry, ['id', 'channelId', 'parentId', 'containerId', 'savedAt', 'snapshot']);
    if (!id(entry.id) || seen.has(entry.id) || !id(entry.channelId) || !nullableId(entry.parentId) || !nullableId(entry.containerId) || !Number.isSafeInteger(entry.savedAt) || entry.savedAt < 0) invalid();
    seen.add(entry.id);
    const value = entry.snapshot;
    shape(value, ['authorId', 'authorName', 'content', 'contentTruncated', 'attachments', 'attachmentsTruncated']);
    if (!nullableId(value.authorId) || !(value.authorName === null || string(value.authorName, 100)) || !(value.content === null || string(value.content, 4000)) || typeof value.contentTruncated !== 'boolean' || typeof value.attachmentsTruncated !== 'boolean') invalid();
    if (value.attachments !== null) {
      if (!Array.isArray(value.attachments) || value.attachments.length > 10) invalid();
      for (const attachment of value.attachments) {
        shape(attachment, ['id', 'name']);
        if (!string(attachment.id, 100) || !string(attachment.name, 256)) invalid();
      }
    }
  }
}
module.exports.create = (write, now) => {
  const prune = config => write(`DELETE FROM omo_module_record WHERE guild_id={:guild} AND module_id='logging' AND key LIKE 'message-cache:%' AND
    (expires_at<={:now} OR {:disabled}=1 OR json_extract(value,'$.channelId')={:destination}
    OR json_extract(value,'$.id') IN (SELECT value FROM json_each({:channels}))
    OR json_extract(value,'$.channelId') IN (SELECT value FROM json_each({:channels}))
    OR json_extract(value,'$.containerId') IN (SELECT value FROM json_each({:channels}))
    OR json_extract(value,'$.id') IN (SELECT value FROM json_each({:categories}))
    OR json_extract(value,'$.parentId') IN (SELECT value FROM json_each({:categories})))`, {
    disabled: !config || !(config.events['message.edited'] || config.events['message.deleted']) ? 1 : 0,
    destination: config ? config.destinationId : null, channels: JSON.stringify(config ? config.excludedChannelIds : []), categories: JSON.stringify(config ? config.excludedCategoryIds : [])
  });
  return {
    prune,
    sync(batch, config) {
      validate(batch); prune(config);
      write(`DELETE FROM omo_module_record WHERE guild_id={:guild} AND module_id='logging' AND key IN (SELECT 'message-cache:'||value FROM json_each({:ids}))`, { ids: JSON.stringify(batch.deletes) });
      const entries = batch.upserts.filter(entry => entry.savedAt <= now && now - entry.savedAt < ttl && allowed(entry, config));
      if (entries.length) write(`INSERT INTO omo_module_record(guild_id,module_id,key,value,updated_at,expires_at)
        SELECT {:guild},'logging',{:prefix}||json_extract(value,'$.id'),value,{:now},json_extract(value,'$.savedAt')+{:ttl} FROM json_each({:entries}) WHERE 1
        ON CONFLICT(guild_id,module_id,key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at,updated_at=excluded.updated_at,revision=omo_module_record.revision+1`,
      { prefix, ttl, entries: JSON.stringify(entries) });
      write(`DELETE FROM omo_module_record WHERE guild_id={:guild} AND module_id='logging' AND key IN
        (SELECT key FROM omo_module_record WHERE guild_id={:guild} AND module_id='logging' AND key LIKE 'message-cache:%' ORDER BY expires_at DESC,key DESC LIMIT -1 OFFSET {:limit})`, { limit });
    }
  };
};
