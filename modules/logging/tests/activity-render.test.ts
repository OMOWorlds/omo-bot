import { expect, it } from 'vitest';
import { renderEvent } from '../bot/render.js';
import { previewEvent } from '../bot/preview.js';
import { eventTypes, defaultLoggingSettings, loggingSettingsSchema } from '../shared/settings.js';
import { loggingDefinition } from '../manifest.js';
const render = (type: typeof eventTypes[number]) => renderEvent(previewEvent(type), 'marker', '#bc9cff').embeds[0]!;
it('shows message edits/deletions with readable content and authors, without guessing who deleted', () => {
  const edit = render('message.edited');
  expect(edit.fields.find(f => f.name === 'Before')?.value).toBe('The meetup starts at 6.');
  expect(edit.fields.find(f => f.name === 'After')?.value).toBe('The meetup starts at 7.');
  expect(edit.fields.find(f => f.name === 'Author')?.value).toContain('<@');
  const deleted = render('message.deleted');
  expect(deleted.fields.find(f => f.name === 'Deleted content')?.value).toBe('The meetup starts at 6.');
  expect(deleted.fields.find(f => f.name === 'Deleted by')?.value).toContain('Unknown');
  expect(deleted.footer.text).toContain('Message ID:');
});
it('distinguishes unavailable content from empty text and renders safe attachment metadata', () => {
  const sample = previewEvent('message.edited');
  sample.before = null; sample.after = { content: '', attachments: [{ name: '@everyone **file.png**' }] };
  const embed = renderEvent(sample, 'marker', '#bc9cff').embeds[0]!;
  expect(embed.fields.find(f => f.name === 'Before')?.value).toContain('unavailable');
  expect(embed.fields.find(f => f.name === 'After')?.value).toBe('No text content');
  expect(embed.fields.find(f => f.name === 'Attachments after')?.value).not.toContain('@everyone');
});
it.each(['message.edited', 'message.deleted'] as const)('identifies the channel for %s without relying on Discord mention resolution', type => {
  const sample = previewEvent(type);
  sample.before = { ...sample.before, channelName: 'general-chat' };
  if (sample.after) sample.after.channelName = 'general-chat';
  const embed = renderEvent(sample, 'marker', '#bc9cff').embeds[0]!;
  expect(embed.description).toContain('#general-chat');
  expect(embed.description).toContain(`Channel ID: ${sample.channelId}`);
  expect(embed.description).toContain(`<#${sample.channelId}>`);
});
it('keeps legacy message events identifiable by channel ID and escapes captured channel names', () => {
  const sample = previewEvent('message.deleted');
  sample.before = { content: null };
  expect(renderEvent(sample, 'marker', '#bc9cff').embeds[0]?.description).toContain(`Channel ID: ${sample.channelId}`);
  sample.before.channelName = '@everyone **unsafe** <#100000000000000099>';
  const description = renderEvent(sample, 'marker', '#bc9cff').embeds[0]!.description;
  expect(description).not.toContain('@everyone');
  expect(description).not.toContain('<#100000000000000099>');
  sample.channelId = null;
  expect(renderEvent(sample, 'marker', '#bc9cff').embeds[0]?.description).toBe('Channel unavailable');
});
it('shows nickname removal, added/removed roles and observed voice channels', () => {
  const nickname = previewEvent('member.nickname.updated'); nickname.after = { nickname: null };
  expect(renderEvent(nickname, 'marker', '#bc9cff').embeds[0]?.fields.find(f => f.name === 'After')?.value).toBe('No nickname');
  const roles = render('member.roles.updated');
  expect(roles.fields.find(f => f.name === 'Roles added')?.value).toBe('<@&100000000000000004>');
  expect(roles.fields.find(f => f.name === 'Roles removed')?.value).toBe('<@&100000000000000003>');
  for (const type of ['voice.joined', 'voice.left'] as const) {
    const embed = render(type); expect(embed.description).toContain('<@100000000000000002>');
    expect(embed.fields).toEqual([{ name: 'Channel', value: '<#100000000000000010>', inline: false }]);
  }
});
it.each(eventTypes)('keeps %s within Discord limits and never enables pings', type => {
  const sample = previewEvent(type), huge = '@everyone **[]<>`'.repeat(2000);
  sample.subjectLabel = huge; sample.reason = huge;
  for (const data of [sample.before, sample.after]) if (data) {
    if ('content' in data) data.content = huge;
    if ('nickname' in data) data.nickname = huge;
    if ('roles' in data) data.roles = Array.from({ length: 250 }, (_, i) => String(200000000000000000n + BigInt(i)));
  }
  const payload = renderEvent(sample, 'marker', '#bc9cff'), embed = payload.embeds[0]!;
  expect(payload.allowedMentions.parse).toEqual([]);
  expect(embed.fields.every(f => f.value.length > 0 && f.value.length <= 1024)).toBe(true);
  expect(embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0)).toBeLessThanOrEqual(6000);
  expect(JSON.stringify(embed)).not.toContain('@everyone'); expect(embed.footer.text.endsWith('marker')).toBe(true);
});
it('upgrades legacy settings without changing routing, retention, exclusions or existing switches', () => {
  const old = { ...defaultLoggingSettings, destinationId: '100000000000000010', metadataRetentionDays: 7, excludedChannelIds: ['100000000000000011'],
    events: { 'channel.created': false, 'channel.updated': true, 'channel.deleted': false } };
  const upgraded = loggingDefinition.settingsMigrations[1](old);
  expect(upgraded).toMatchObject(old);
  for (const type of eventTypes.filter(t => !t.startsWith('channel.'))) expect(upgraded.events[type]).toBe(false);
  expect(loggingSettingsSchema.parse(upgraded)).toEqual(upgraded);
  expect(eventTypes.every(t => defaultLoggingSettings.events[t])).toBe(true);
});
