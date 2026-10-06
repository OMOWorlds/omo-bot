import { eventLabels as titles, type LogEvent } from '../shared/settings.js';
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const suffix = '… [truncated]';
  if (limit <= suffix.length) return suffix.slice(0, Math.max(0, limit));
  // Avoid splitting a surrogate pair or leaving a dangling Markdown escape.
  return text.slice(0, Math.max(0, limit - suffix.length)).replace(/[\uD800-\uDBFF\\]+$/u, '') + suffix;
}
export function escapeText(value: string): string { return value.replace(/([\\`*_{}[\]()<>#|~])/g, '\\$1').replace(/@/g, '@\u200b'); }
const safeText = (value: string, limit = 350) => clip(escapeText(value), limit);
const isId = (value: unknown): value is string => typeof value === 'string' && /^\d{17,20}$/.test(value);
const labels = { name: 'Name', type: 'Type', parentId: 'Category', topic: 'Topic', nsfw: 'Age restricted', slowmode: 'Slowmode', position: 'Position' };
const channelTypes: Record<string, string> = {
  GuildText: 'Text channel', text: 'Text channel', '0': 'Text channel',
  GuildVoice: 'Voice channel', '2': 'Voice channel', GuildCategory: 'Category', '4': 'Category',
  GuildAnnouncement: 'Announcement channel', '5': 'Announcement channel',
  AnnouncementThread: 'Announcement thread', '10': 'Announcement thread', PublicThread: 'Public thread', '11': 'Public thread',
  PrivateThread: 'Private thread', '12': 'Private thread', GuildStageVoice: 'Stage channel', '13': 'Stage channel',
  GuildDirectory: 'Directory', '14': 'Directory', GuildForum: 'Forum channel', '15': 'Forum channel', GuildMedia: 'Media channel', '16': 'Media channel'
};
type Field = { name: string; value: string; inline: boolean };
type Overwrite = { id: string; type: 0 | 1; allow: string[]; deny: string[] };

function valueLabel(key: keyof typeof labels, value: unknown): string {
  if (value === undefined) return 'Not recorded';
  if (key === 'parentId') return value === null ? 'No category' : isId(value) ? `<#${value}>` : 'Not recorded';
  if (key === 'nsfw') return typeof value === 'boolean' ? value ? 'Yes' : 'No' : 'Not recorded';
  if (key === 'slowmode') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Not recorded';
    if (value === 0) return 'Off';
    return [[Math.floor(value / 3600), 'h'], [Math.floor(value % 3600 / 60), 'm'], [value % 60, 's']].filter(([n]) => n).map(([n, unit]) => `${n}${unit}`).join(' ');
  }
  if (key === 'type') {
    if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) return 'Not recorded';
    return Object.hasOwn(channelTypes, String(value)) ? channelTypes[String(value)]! : safeText(String(value));
  }
  if (value === null || value === '') return 'None';
  return typeof value === 'string' || typeof value === 'number' ? safeText(String(value)) : 'Not recorded';
}

function overwrites(value: unknown): Overwrite[] | null {
  if (!Array.isArray(value)) return null;
  const result: Overwrite[] = [], ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || !isId(entry.id) || ![0, 1].includes(entry.type)
      || !Array.isArray(entry.allow) || !Array.isArray(entry.deny)
      || ![...entry.allow, ...entry.deny].every(p => typeof p === 'string')
      || entry.allow.some((p: string) => entry.deny.includes(p)) || ids.has(`${entry.type}:${entry.id}`)) return null;
    ids.add(`${entry.type}:${entry.id}`);
    result.push({ id: entry.id, type: entry.type, allow: [...new Set<string>(entry.allow)].sort(), deny: [...new Set<string>(entry.deny)].sort() });
  }
  return result.sort((a, b) => a.type - b.type || a.id.localeCompare(b.id));
}

function permissionSummary(value: Overwrite[] | null): string {
  if (!value) return 'Not recorded';
  if (!value.length) return 'No custom overwrites';
  const roles = value.filter(o => o.type === 0).length, members = value.length - roles;
  const targets = [roles ? `${roles} role${roles === 1 ? '' : 's'}` : '', members ? `${members} member${members === 1 ? '' : 's'}` : ''].filter(Boolean);
  return `${value.length} custom overwrite${value.length === 1 ? '' : 's'} · ${targets.join(', ')}`;
}

function permissionChanges(beforeValue: unknown, afterValue: unknown): string | null {
  if (beforeValue === undefined && afterValue === undefined) return null;
  const before = overwrites(beforeValue), after = overwrites(afterValue);
  if (!before || !after) return `Before: ${permissionSummary(before)}\nAfter: ${permissionSummary(after)}`;
  const key = (o: Overwrite) => `${o.type}:${o.id}`;
  const old = new Map(before.map(o => [key(o), o])), next = new Map(after.map(o => [key(o), o]));
  const targets = [...new Set([...old.keys(), ...next.keys()])].sort();
  const state = (o: Overwrite | undefined, permission: string) => o?.allow.includes(permission) ? 'Allowed' : o?.deny.includes(permission) ? 'Denied' : 'Inherited';
  const changes: string[] = [];
  for (const target of targets) {
    const previous = old.get(target), current = next.get(target), subject = current ?? previous!;
    const permissions = [...new Set([...(previous?.allow ?? []), ...(previous?.deny ?? []), ...(current?.allow ?? []), ...(current?.deny ?? [])])].sort();
    const changed = permissions.filter(p => state(previous, p) !== state(current, p));
    if (!changed.length && previous && current) continue;
    const mention = subject.type === 0 ? `<@&${subject.id}>` : `<@${subject.id}>`;
    const heading = `${mention}${!previous ? ' · Overwrite added' : !current ? ' · Overwrite removed' : ''}`;
    const lines = changed.slice(0, 4).map(p => {
      const words = p.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase();
      const name = safeText(words.charAt(0).toUpperCase() + words.slice(1), 60);
      return `${name}: ${state(previous, p)} → ${state(current, p)}`;
    });
    if (changed.length > 4) lines.push(`+${changed.length - 4} more permission changes`);
    if (!changed.length) lines.push('No explicit allows or denies');
    changes.push([heading, ...lines].join('\n'));
  }
  if (!changes.length) return null;
  const overflow = changes.length > 3 ? `+${changes.length - 3} more overwrites changed. Full details in dashboard.` : '';
  const blockLimit = Math.floor((900 - overflow.length - 8) / Math.min(changes.length, 3));
  const visible = changes.slice(0, 3).map(change => clip(change, blockLimit));
  if (overflow) visible.push(overflow);
  return visible.join('\n\n');
}

function channelFields(event: LogEvent): Field[] {
  const fields: Field[] = [];
  const add = (name: string, value: string, inline = false) => fields.push({ name, value, inline });
  if (event.type === 'channel.updated') {
    for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
      const before = event.before?.[key], after = event.after?.[key];
      if (before === after) continue;
      const from = valueLabel(key, before), to = valueLabel(key, after);
      add(labels[key], key === 'topic' ? `Before: ${from}\nAfter: ${to}` : `${from} → ${to}`);
    }
    const permissions = permissionChanges(event.before?.overwrites, event.after?.overwrites);
    if (permissions) add('Permissions', permissions);
    if (!fields.length) add('Details', !event.before || !event.after ? 'Channel details were not recorded.' : 'No displayable channel changes. Full details in dashboard.');
  } else {
    const snapshot = event.type === 'channel.deleted' ? event.before : event.after;
    if (!snapshot) add('Details', 'Channel details were not recorded.');
    else {
      for (const key of ['type', 'parentId'] as const) if (key in snapshot) add(labels[key], valueLabel(key, snapshot[key]), true);
      if (typeof snapshot.topic === 'string' && snapshot.topic.trim()) add('Topic', valueLabel('topic', snapshot.topic));
      if (snapshot.nsfw === true) add('Age restricted', 'Yes', true);
      if (typeof snapshot.slowmode === 'number' && snapshot.slowmode > 0) add('Slowmode', valueLabel('slowmode', snapshot.slowmode), true);
      if ('overwrites' in snapshot) add('Permissions', permissionSummary(overwrites(snapshot.overwrites)));
    }
  }
  const actorLabel = event.type === 'channel.created' ? 'Created by' : event.type === 'channel.deleted' ? 'Deleted by' : 'Updated by';
  add(actorLabel, isId(event.actorId) ? `<@${event.actorId}>` : 'Unknown · no confirmed audit evidence');
  if (event.reason?.trim()) add('Reason', safeText(event.reason, 500));
  return fields;
}

function activityFields(event: LogEvent): Field[] {
  const fields: Field[] = [];
  const add = (name: string, value: string, inline = false) => fields.push({ name, value, inline });
  const snapshot = event.after ?? event.before;
  const text = (data: Record<string, unknown> | null) => typeof data?.content === 'string'
    ? data.content ? safeText(data.content, 820) + (data.contentTruncated ? '\nAdditional text was not captured.' : '') : 'No text content'
    : 'Content unavailable. It was not cached or not provided by Discord.';
  const attachments = (data: Record<string, unknown> | null) => {
    if (!Array.isArray(data?.attachments)) return 'Attachment details unavailable';
    if (!data.attachments.length) return 'None';
    return data.attachments.slice(0, 10).map(a => a && typeof a.name === 'string' ? safeText(a.name, 70) : 'Unnamed attachment').join('\n')
      + (data.attachmentsTruncated ? '\nAdditional attachments were not captured.' : '');
  };
  const roles = (value: unknown) => Array.isArray(value) ? value.filter(isId) : [];
  const roleList = (ids: string[]) => ids.slice(0, 20).map(id => `<@&${id}>`).join(' ')
    + (ids.length > 20 ? `\n+${ids.length - 20} more roles. Full details in dashboard.` : '');
  if (event.type.startsWith('message.')) {
    add('Author', isId(snapshot?.authorId) ? `<@${snapshot.authorId}>` : 'Unknown');
    if (event.type === 'message.edited') {
      add('Before', text(event.before)); add('After', text(event.after));
      if (JSON.stringify(event.before?.attachments) !== JSON.stringify(event.after?.attachments)) {
        add('Attachments before', attachments(event.before)); add('Attachments after', attachments(event.after));
      }
    } else {
      add('Deleted content', typeof event.before?.content === 'string' ? text(event.before)
        : 'Content unavailable. No saved copy was available when Discord reported the deletion; deleted text cannot be fetched afterward.');
      if (Array.isArray(event.before?.attachments) && event.before.attachments.length) add('Attachments', attachments(event.before));
      add('Deleted by', isId(event.actorId) ? `<@${event.actorId}>` : 'Unknown · no confirmed audit evidence');
    }
  } else if (event.type === 'member.nickname.updated') {
    const nickname = (data: Record<string, unknown> | null) => data?.nickname === null ? 'No nickname'
      : typeof data?.nickname === 'string' ? safeText(data.nickname) || 'No nickname' : 'Not recorded';
    add('Before', nickname(event.before), true); add('After', nickname(event.after), true);
    add('Changed by', isId(event.actorId) ? `<@${event.actorId}>` : 'Unknown · no confirmed audit evidence');
  } else if (event.type === 'member.roles.updated') {
    if (!Array.isArray(event.before?.roles) || !Array.isArray(event.after?.roles)) add('Roles', 'Previous or current roles unavailable. Changes cannot be determined.');
    else {
      const before = roles(event.before.roles), after = roles(event.after.roles);
      const added = after.filter(id => !before.includes(id)), removed = before.filter(id => !after.includes(id));
      if (added.length) add('Roles added', roleList(added));
      if (removed.length) add('Roles removed', roleList(removed));
      if (!added.length && !removed.length) add('Roles', 'No role changes');
    }
    add('Changed by', isId(event.actorId) ? `<@${event.actorId}>` : 'Unknown · no confirmed audit evidence');
  } else if (event.type.startsWith('voice.')) {
    add('Channel', isId(event.channelId) ? `<#${event.channelId}>` : 'Not recorded');
  }
  if (event.reason?.trim()) add('Reason', safeText(event.reason, 500));
  return fields;
}

export function renderEvent(event: LogEvent, marker: string, accentColor: string) {
  const test = event.type === 'logging.test';
  const title = Object.hasOwn(titles, event.type) ? titles[event.type]! : 'Activity observed';
  const message = event.type.startsWith('message.'), member = event.type.startsWith('member.') || event.type.startsWith('voice.');
  const channelName = event.after?.channelName ?? event.before?.channelName;
  const messageChannel = !isId(event.channelId) ? 'Channel unavailable'
    : `${typeof channelName === 'string' && channelName ? `${safeText(`#${channelName}`, 200)} · ` : ''}<#${event.channelId}>\nChannel ID: ${event.channelId}`;
  const description = test ? 'Log delivery is working. This test was requested by an administrator.'
    : message ? messageChannel
    : `${member && isId(event.subjectId) ? `<@${event.subjectId}> · ` : ''}${safeText(event.subjectLabel, 200)}${!member && event.type !== 'channel.deleted' && isId(event.channelId) ? ` · <#${event.channelId}>` : ''}`;
  // The footer suffix is used by DiscordTransport.find for retry reconciliation.
  const footer = { text: test ? `Delivery reference · ${marker}` : `${message ? 'Message' : member ? 'Member' : 'Channel'} ID: ${event.subjectId} · ${marker}` };
  const fields = test ? [] : message || member ? activityFields(event) : channelFields(event);
  // Reserve total text space as well as respecting each field's individual limit.
  let budget = 5800 - title.length - description.length - footer.text.length;
  for (const field of fields) {
    const limit = Math.min(900, budget - field.name.length);
    field.value = clip(field.value, limit);
    budget -= field.name.length + field.value.length;
  }
  return {
    allowedMentions: { parse: [] as ('roles' | 'users' | 'everyone')[], repliedUser: false },
    embeds: [{ title, color: Number.parseInt(accentColor.slice(1), 16), description, fields, timestamp: event.observedAt, footer }]
  };
}
