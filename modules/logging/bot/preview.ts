import type { LogEvent, LoggingEventType } from '../shared/settings.js';

/** Synthetic examples only. Never sent or saved by the preview endpoint. */
export function previewEvent(type: LoggingEventType): LogEvent {
  const channel = '100000000000000010', member = '100000000000000002';
  const message = { authorId: member, authorName: 'Sample member', channelName: 'sample-channel', content: 'The meetup starts at 6.', attachments: [] };
  const data = { name: 'new-channel', type: 'GuildText', parentId: null, topic: 'A new place for your community.', nsfw: false, slowmode: 0,
    overwrites: [{ id: '100000000000000003', type: 0, allow: ['ViewChannel'], deny: ['ManageChannels'] }] };
  const event: LogEvent = { id: crypto.randomUUID(), type, subjectId: channel, subjectLabel: 'new-channel', channelId: null,
    parentId: null, observedAt: new Date().toISOString(), before: null, after: data, actorId: null, reason: null,
    attribution: 'unavailable', configRevision: 0, expiresAt: new Date().toISOString(), deliveryState: null, messageId: null, destinationId: null };
  if (type === 'channel.updated') event.before = { ...data, name: 'old-channel' };
  if (type === 'channel.deleted') { event.before = data; event.after = null; }
  if (type.startsWith('message.')) {
    event.subjectId = '100000000000000030'; event.subjectLabel = 'Sample member'; event.channelId = channel;
    event.before = message; event.after = type === 'message.edited' ? { ...message, content: 'The meetup starts at 7.' } : null;
  }
  if (type.startsWith('member.') || type.startsWith('voice.')) {
    event.subjectId = member; event.subjectLabel = 'Sample member';
    if (type === 'member.nickname.updated') { event.before = { nickname: 'Old nickname' }; event.after = { nickname: 'New nickname' }; }
    if (type === 'member.roles.updated') { event.before = { roles: ['100000000000000003'] }; event.after = { roles: ['100000000000000004'] }; }
    if (type.startsWith('voice.')) {
      event.channelId = channel; event.before = type === 'voice.left' ? { channelId: channel } : null;
      event.after = type === 'voice.joined' ? { channelId: channel } : null;
    }
  }
  return event;
}
