import type { GatewayDispatchPayload, GatewayMessageUpdateDispatchData } from 'discord.js';
import type { Observation } from '../../../packages/module-sdk/src/server.js';
import type { LoggingSettings } from '../shared/settings.js';
import { eventEnabled, excludedEvent } from '../shared/policy.js';
import { MESSAGE_CACHE_LIMIT, MESSAGE_CACHE_TTL, type MessageCacheEntry, type MessageSnapshot } from '../shared/message-cache.js';
export { MESSAGE_CACHE_LIMIT, MESSAGE_CACHE_TTL } from '../shared/message-cache.js';

export interface ChannelScope { parentId: string | null; containerId: string | null; name?: string }
export interface MemberSnapshot { nickname: string | null; roles: string[]; label: string }
interface CollectorContext {
  guildId: string;
  botId(): string | undefined;
  settings(): LoggingSettings | null;
  channel(id: string): ChannelScope | null;
  member(id: string): MemberSnapshot | null;
  voiceChannel(id: string): string | null;
  emit(event: Observation): void;
  missingMemberBaseline(): void;
}
const emptyMessage = (): MessageSnapshot => ({ authorId: null, authorName: null, content: null, contentTruncated: false, attachments: null, attachmentsTruncated: false });

/** Raw dispatch runs before discord.js updates its member/voice caches. Persistence is batched separately. */
export class ActivityCollector {
  private messages = new Map<string, MessageCacheEntry>();
  private policy: LoggingSettings | null = null;
  constructor(private context: CollectorContext, private now: () => number = Date.now) {}
  get cachedMessages() { return this.messages.size; }
  clear() { this.messages.clear(); }
  messageEntries() { this.syncPolicy(); return new Map(this.messages); }
  restoreMessages(entries: MessageCacheEntry[]) {
    this.syncPolicy();
    for (const entry of [...entries].sort((a, b) => a.savedAt - b.savedAt)) {
      if (entry.savedAt > this.now() || this.now() - entry.savedAt >= MESSAGE_CACHE_TTL || this.messages.has(entry.id)) continue;
      if (this.scope('message.edited', entry.id, entry.channelId) || this.scope('message.deleted', entry.id, entry.channelId)) this.messages.set(entry.id, entry);
    }
    while (this.messages.size > MESSAGE_CACHE_LIMIT) this.messages.delete(this.messages.keys().next().value!);
  }
  syncPolicy() {
    this.policy = this.context.settings();
    if (!this.policy) { this.clear(); return; }
    for (const [id, entry] of this.messages) {
      const scope = this.scope('message.edited', id, entry.channelId) ?? this.scope('message.deleted', id, entry.channelId);
      if (!scope || this.now() - entry.savedAt >= MESSAGE_CACHE_TTL) this.messages.delete(id);
      else if (scope.parentId !== entry.parentId || scope.containerId !== entry.containerId) {
        this.messages.set(id, { ...entry, parentId: scope.parentId, containerId: scope.containerId });
      }
    }
  }
  private remember(id: string, channelId: string, snapshot: MessageSnapshot) {
    const scope = this.context.channel(channelId);
    if (!scope) return;
    this.messages.delete(id);
    this.messages.set(id, { id, snapshot, savedAt: this.now(), channelId, parentId: scope.parentId, containerId: scope.containerId });
    while (this.messages.size > MESSAGE_CACHE_LIMIT) this.messages.delete(this.messages.keys().next().value!);
  }
  private messageSnapshot(data: GatewayMessageUpdateDispatchData, previous?: MessageSnapshot): MessageSnapshot {
    const next = { ...(previous ?? emptyMessage()) };
    if (data.author) { next.authorId = data.author.id; next.authorName = (data.author.global_name ?? data.author.username).slice(0, 100); }
    if (typeof data.content === 'string') { next.content = data.content.slice(0, 4000); next.contentTruncated = data.content.length > 4000; }
    if (data.attachments) {
      next.attachments = data.attachments.slice(0, 10).map(a => ({ id: a.id, name: a.filename.slice(0, 256) })).sort((a, b) => a.id.localeCompare(b.id));
      next.attachmentsTruncated = data.attachments.length > 10;
    }
    return next;
  }
  private scope(type: string, subjectId: string, channelId: string | null): ChannelScope | null {
    if (!this.policy || !eventEnabled(type, this.policy)) return null;
    const scope = channelId ? this.context.channel(channelId) : { parentId: null, containerId: null };
    if (!scope || excludedEvent({ type, subjectId, channelId, parentId: scope.parentId, before: null, after: { containerId: scope.containerId } }, this.policy)) return null;
    return scope;
  }
  private emit(type: string, subjectId: string, channelId: string | null, label: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, sourceKey: string) {
    const scope = this.scope(type, subjectId, channelId);
    if (!scope) return;
    const channelName = scope.name ? { channelName: scope.name.slice(0, 100) } : {};
    this.context.emit({ guildId: this.context.guildId, type, subjectId, channelId, parentId: scope.parentId, label: label.slice(0, 200),
      before: before ? { ...before, ...channelName, containerId: scope.containerId } : null, after: after ? { ...after, ...channelName, containerId: scope.containerId } : null,
      observedAt: new Date(this.now()).toISOString(), sourceKey });
  }
  handle(packet: GatewayDispatchPayload, sourceKey: string) {
    this.syncPolicy();
    if (!this.policy || !packet.d || !('guild_id' in packet.d) || packet.d.guild_id !== this.context.guildId) return;
    switch (packet.t) {
      case 'MESSAGE_CREATE':
      case 'MESSAGE_UPDATE': {
        const data = packet.d;
        const hasEditableFields = typeof data.content === 'string' || data.attachments !== undefined;
        if (packet.t === 'MESSAGE_UPDATE' && !hasEditableFields) return;
        if (!this.scope('message.edited', data.id, data.channel_id) && !this.scope('message.deleted', data.id, data.channel_id)) {
          this.messages.delete(data.id); return;
        }
        const entry = this.messages.get(data.id);
        const previous = entry?.channelId === data.channel_id ? entry.snapshot : undefined;
        const next = this.messageSnapshot(data, previous);
        // Keep only metadata for our own messages so later deletes can be ignored too.
        if (next.authorId === this.context.botId()) { this.remember(data.id, data.channel_id, { ...emptyMessage(), authorId: next.authorId }); return; }
        this.remember(data.id, data.channel_id, next);
        if (packet.t === 'MESSAGE_CREATE') return;
        if (previous && previous.content === next.content && JSON.stringify(previous.attachments) === JSON.stringify(next.attachments)) return;
        if (!previous && !data.edited_timestamp) return; // No evidence of an edit without a baseline.
        this.emit('message.edited', data.id, data.channel_id, next.authorName ?? 'Unknown author', previous ?? null, next, `${sourceKey}:edit`);
        break;
      }
      case 'MESSAGE_DELETE':
      case 'MESSAGE_DELETE_BULK': {
        const data = packet.d;
        const ids = 'ids' in data ? data.ids : [data.id];
        for (const id of ids) {
          const entry = this.messages.get(id);
          const previous = entry?.channelId === data.channel_id ? entry.snapshot : undefined;
          this.messages.delete(id);
          if (previous?.authorId === this.context.botId() && previous?.authorId) continue;
          this.emit('message.deleted', id, data.channel_id, previous?.authorName ?? 'Unknown author', previous ?? emptyMessage(), null, `message:deleted:${id}`);
        }
        break;
      }
      case 'GUILD_MEMBER_UPDATE': {
        if (!this.policy.events['member.nickname.updated'] && !this.policy.events['member.roles.updated']) return;
        const data = packet.d, previous = this.context.member(data.user.id);
        if (!previous) { this.context.missingMemberBaseline(); return; }
        const label = data.user.global_name ?? data.user.username;
        if (data.nick !== undefined && previous.nickname !== data.nick) {
          this.emit('member.nickname.updated', data.user.id, null, label, { nickname: previous.nickname }, { nickname: data.nick }, `${sourceKey}:nickname`);
        }
        const roles = [...new Set(data.roles)].filter(id => id !== this.context.guildId).sort();
        const before = [...new Set(previous.roles)].filter(id => id !== this.context.guildId).sort();
        if (JSON.stringify(before) !== JSON.stringify(roles)) {
          this.emit('member.roles.updated', data.user.id, null, label, { roles: before }, { roles }, `${sourceKey}:roles`);
        }
        break;
      }
      case 'VOICE_STATE_UPDATE': {
        const data = packet.d, previous = this.context.voiceChannel(data.user_id);
        if (previous === data.channel_id) return;
        const label = data.member?.user?.global_name ?? data.member?.user?.username ?? this.context.member(data.user_id)?.label ?? 'Member';
        if (previous) this.emit('voice.left', data.user_id, previous, label, { channelId: previous }, null, `${sourceKey}:leave`);
        if (data.channel_id) this.emit('voice.joined', data.user_id, data.channel_id, label, null, { channelId: data.channel_id }, `${sourceKey}:join`);
        break;
      }
    }
  }
}
