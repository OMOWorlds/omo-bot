import { describe, expect, it } from 'vitest';
import type { GatewayDispatchPayload } from 'discord.js';
import { ActivityCollector, MESSAGE_CACHE_LIMIT, MESSAGE_CACHE_TTL, type MemberSnapshot } from '../bot/collect.js';
import { defaultLoggingSettings, type LoggingSettings } from '../shared/settings.js';
import type { Observation } from '../../../packages/module-sdk/src/server.js';

const guild = '100000000000000001', user = '100000000000000002', bot = '100000000000000003';
const channel = '100000000000000010', other = '100000000000000011', category = '100000000000000020', message = '100000000000000030';
const role = '100000000000000040', secondRole = '100000000000000041';
function fixture() {
  let settings: LoggingSettings | null = structuredClone({ ...defaultLoggingSettings, destinationId: other });
  let now = Date.parse('2026-09-30T12:00:00Z'), member: MemberSnapshot | null = { nickname: 'Before', roles: [guild, role], label: 'Member' };
  let voice: string | null = null, gaps = 0, sequence = 0;
  const events: Observation[] = [];
  const collector = new ActivityCollector({ guildId: guild, botId: () => bot, settings: () => settings,
    channel: id => [channel, other].includes(id) ? { parentId: category, containerId: null, name: 'general-chat' } : null,
    member: () => member, voiceChannel: () => voice, emit: e => events.push(e), missingMemberBaseline: () => { gaps++; }
  }, () => now);
  const dispatch = (t: string, d: Record<string, unknown>) => collector.handle({ op: 0, t, s: ++sequence, d: { guild_id: guild, ...d } } as GatewayDispatchPayload, `gateway:${sequence}`);
  const create = (patch: Record<string, unknown> = {}) => dispatch('MESSAGE_CREATE', { id: message, channel_id: channel, author: { id: user, username: 'Member' }, content: 'Before', attachments: [], ...patch });
  return { events, collector, dispatch, create, setPolicy: (value: LoggingSettings | null) => { settings = value; collector.syncPolicy(); },
    settings: () => settings!, advance: (ms: number) => { now += ms; }, setMember: (v: MemberSnapshot | null) => { member = v; }, setVoice: (v: string | null) => { voice = v; }, gaps: () => gaps };
}
describe('message observations', () => {
  it('caches new messages without persisting them, captures edits then deletes the latest content', () => {
    const f = fixture(); f.create(); expect(f.events).toEqual([]); expect(f.collector.cachedMessages).toBe(1);
    f.dispatch('MESSAGE_UPDATE', { id: message, channel_id: channel, content: 'After', edited_timestamp: '2026-09-30T12:01:00Z' });
    f.dispatch('MESSAGE_DELETE', { id: message, channel_id: channel });
    expect(f.events.map(e => e.type)).toEqual(['message.edited', 'message.deleted']);
    expect(f.events[0]?.before?.content).toBe('Before'); expect(f.events[0]?.after?.content).toBe('After');
    expect(f.events[1]?.before?.content).toBe('After'); expect(f.events[1]?.before?.authorId).toBe(user);
    expect(f.events[0]?.after?.channelName).toBe('general-chat');
    expect(f.events[1]?.before?.channelName).toBe('general-chat');
    expect(f.events[1]?.subjectId).toBe(message); expect(f.collector.cachedMessages).toBe(0);
  });
  it('ignores embed/pin/reaction updates and unchanged content including reordered attachments', () => {
    const f = fixture(); f.create({ attachments: [{ id: 'b', filename: 'b.png' }, { id: 'a', filename: 'a.png' }] });
    f.dispatch('MESSAGE_UPDATE', { id: message, channel_id: channel, embeds: [{ title: 'Preview' }], pinned: true });
    f.dispatch('MESSAGE_UPDATE', { id: message, channel_id: channel, content: 'Before', attachments: [{ id: 'a', filename: 'a.png' }, { id: 'b', filename: 'b.png' }] });
    expect(f.events).toEqual([]);
  });
  it('captures attachment removals and empty content without losing known author or text', () => {
    const f = fixture(); f.create({ attachments: [{ id: 'a', filename: 'photo.png', url: 'https://example.com/private' }] });
    f.dispatch('MESSAGE_UPDATE', { id: message, channel_id: channel, attachments: [] });
    expect(f.events[0]?.before?.attachments).toEqual([{ id: 'a', name: 'photo.png' }]);
    expect(f.events[0]?.after).toMatchObject({ content: 'Before', authorId: user, attachments: [] });
    f.dispatch('MESSAGE_UPDATE', { id: message, channel_id: channel, content: '' });
    expect(f.events[1]?.after?.content).toBe('');
  });
  it('marks uncached deletion/edit baselines unavailable and requires edit evidence for uncached updates', () => {
    const f = fixture();
    f.dispatch('MESSAGE_DELETE', { id: message, channel_id: channel });
    expect(f.events[0]?.before?.content).toBeNull(); expect(f.events[0]?.before?.authorId).toBeNull(); expect(f.events[0]?.after).toBeNull();
    f.dispatch('MESSAGE_UPDATE', { id: '100000000000000031', channel_id: channel, embeds: [] });
    expect(f.events).toHaveLength(1);
    f.dispatch('MESSAGE_UPDATE', { id: message, channel_id: channel, content: 'Edited', edited_timestamp: '2026-09-30T12:01:00Z' });
    expect(f.events[1]?.before).toBeNull(); expect(f.events[1]?.after?.content).toBe('Edited');
  });
  it('captures each bulk deletion with stable keys matching individual deletion delivery', () => {
    const f = fixture(); f.create();
    f.dispatch('MESSAGE_DELETE_BULK', { ids: [message, '100000000000000031'], channel_id: channel });
    expect(f.events).toHaveLength(2); expect(f.events[0]?.before?.content).toBe('Before'); expect(f.events[1]?.before?.content).toBeNull();
    f.dispatch('MESSAGE_DELETE', { id: message, channel_id: channel });
    expect(f.events[2]?.sourceKey).toBe(f.events[0]?.sourceKey);
  });
  it('enforces cache count, TTL, snapshot size and explicit reset', () => {
    const f = fixture();
    for (let i = 0; i <= MESSAGE_CACHE_LIMIT; i++) f.create({ id: String(100000000000000100n + BigInt(i)), content: 'x'.repeat(5000) });
    expect(f.collector.cachedMessages).toBe(MESSAGE_CACHE_LIMIT); expect(f.events).toEqual([]);
    f.dispatch('MESSAGE_DELETE', { id: '100000000000000100', channel_id: channel }); expect(f.events[0]?.before?.content).toBeNull();
    f.dispatch('MESSAGE_DELETE', { id: '100000000000000101', channel_id: channel });
    expect(f.events[1]?.before?.content).toHaveLength(4000); expect(f.events[1]?.before?.contentTruncated).toBe(true);
    f.advance(MESSAGE_CACHE_TTL); f.collector.syncPolicy(); expect(f.collector.cachedMessages).toBe(0);
    f.create(); f.collector.clear(); expect(f.collector.cachedMessages).toBe(0);
  });
  it('retains a saved author and text for deletions after the old 30-minute window', () => {
    const f = fixture(); f.create(); f.advance(60 * 60 * 1000);
    f.dispatch('MESSAGE_DELETE', { id: message, channel_id: channel });
    expect(f.events[0]?.before).toMatchObject({ content: 'Before', authorId: user });
  });
  it('preserves eligible snapshots across settings changes and purges newly excluded messages', () => {
    const f = fixture(); f.create();
    f.setPolicy({ ...f.settings(), accentColor: '#ffffff', metadataRetentionDays: 7 });
    f.dispatch('MESSAGE_DELETE', { id: message, channel_id: channel });
    expect(f.events[0]?.before).toMatchObject({ content: 'Before', authorId: user });
    f.setPolicy({ ...f.settings(), destinationId: null });
    f.create(); f.create({ id: '100000000000000031', channel_id: other });
    f.setPolicy({ ...f.settings(), excludedChannelIds: [channel] });
    expect(f.collector.cachedMessages).toBe(1);
    f.dispatch('MESSAGE_DELETE', { id: '100000000000000031', channel_id: other });
    expect(f.events[1]?.before?.content).toBe('Before');
    f.setPolicy({ ...f.settings(), excludedChannelIds: [] });
    f.dispatch('MESSAGE_DELETE', { id: message, channel_id: channel });
    expect(f.events[2]?.before?.content).toBeNull();
    f.create();
    f.setPolicy({ ...f.settings(), events: { ...f.settings().events, 'message.edited': false, 'message.deleted': false } });
    expect(f.collector.cachedMessages).toBe(0);
  });
  it('applies event switches, exclusions, guild scope, disabling and own-message suppression', () => {
    const f = fixture(); f.create(); f.setPolicy({ ...f.settings(), events: { ...f.settings().events, 'message.edited': false } });
    expect(f.collector.cachedMessages).toBe(1);
    f.create(); f.dispatch('MESSAGE_UPDATE', { id: message, channel_id: channel, content: 'After' }); expect(f.events).toEqual([]);
    f.dispatch('MESSAGE_DELETE', { id: message, channel_id: channel }); expect(f.events).toHaveLength(1);
    for (const patch of [{ excludedChannelIds: [channel] }, { excludedCategoryIds: [category] }, { destinationId: channel }]) {
      f.setPolicy({ ...defaultLoggingSettings, ...patch }); f.create(); f.dispatch('MESSAGE_DELETE', { id: message, channel_id: channel });
      expect(f.collector.cachedMessages).toBe(0); expect(f.events).toHaveLength(1);
    }
    f.setPolicy(defaultLoggingSettings); f.create({ guild_id: 'different' }); f.create({ guild_id: undefined });
    f.create({ channel_id: 'unknown' }); expect(f.collector.cachedMessages).toBe(0);
    f.create({ author: { id: bot, username: 'Bot' } }); f.dispatch('MESSAGE_DELETE', { id: message, channel_id: channel }); expect(f.events).toHaveLength(1);
    f.create(); f.setPolicy(null); expect(f.collector.cachedMessages).toBe(0); f.create(); expect(f.collector.cachedMessages).toBe(0);
  });
});
describe('member and voice observations', () => {
  it('captures nickname removal and the actual role set change without assuming an actor', () => {
    const f = fixture(); f.dispatch('GUILD_MEMBER_UPDATE', { user: { id: user, username: 'Member' }, nick: null, roles: [secondRole] });
    expect(f.events.map(e => e.type)).toEqual(['member.nickname.updated', 'member.roles.updated']);
    expect(f.events[0]?.before).toMatchObject({ nickname: 'Before' }); expect(f.events[0]?.after).toMatchObject({ nickname: null });
    expect(f.events[1]?.before).toMatchObject({ roles: [role] }); expect(f.events[1]?.after).toMatchObject({ roles: [secondRole] });
    expect(f.events.every(e => e.subjectId === user && e.channelId === null)).toBe(true);
    expect(f.events[0]).not.toHaveProperty('actorId');
  });
  it('ignores unrelated member changes, role order and unknown before-state', () => {
    const f = fixture(); f.setMember({ nickname: null, roles: [role, secondRole, guild], label: 'Member' });
    f.dispatch('GUILD_MEMBER_UPDATE', { user: { id: user, username: 'Renamed username' }, roles: [secondRole, role], nick: null });
    expect(f.events).toEqual([]);
    f.setMember(null); f.dispatch('GUILD_MEMBER_UPDATE', { user: { id: user, username: 'Member' }, roles: [role], nick: 'New' });
    expect(f.events).toEqual([]); expect(f.gaps()).toBe(1);
  });
  it('logs joins and leaves, splits moves, and ignores mute/deafen-only updates', () => {
    const f = fixture(); f.setPolicy({ ...f.settings(), destinationId: null });
    f.dispatch('VOICE_STATE_UPDATE', { user_id: user, channel_id: channel });
    f.setVoice(channel); f.dispatch('VOICE_STATE_UPDATE', { user_id: user, channel_id: channel, self_mute: true });
    expect(f.events).toHaveLength(1);
    f.dispatch('VOICE_STATE_UPDATE', { user_id: user, channel_id: other });
    f.setVoice(other); f.dispatch('VOICE_STATE_UPDATE', { user_id: user, channel_id: null });
    expect(f.events.map(e => [e.type, e.channelId])).toEqual([['voice.joined', channel], ['voice.left', channel], ['voice.joined', other], ['voice.left', other]]);
    expect(new Set(f.events.map(e => e.sourceKey)).size).toBe(4);
  });
  it('evaluates each side of voice moves against exclusions and switches', () => {
    const f = fixture(); f.setVoice(channel); f.setPolicy({ ...f.settings(), excludedChannelIds: [channel] });
    f.dispatch('VOICE_STATE_UPDATE', { user_id: user, channel_id: other });
    expect(f.events.map(e => e.type)).toEqual(['voice.joined']);
    f.setPolicy({ ...f.settings(), events: { ...f.settings().events, 'voice.joined': false } });
    f.dispatch('VOICE_STATE_UPDATE', { user_id: user, channel_id: other }); expect(f.events).toHaveLength(1);
  });
});
