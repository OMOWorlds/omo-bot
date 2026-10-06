import { WorkerCycle, pocketHostPollMs } from '../../../packages/core/src/worker-cycle.js';
import { installedDefinitions } from '../../../registry/definitions.js';
import { requiredIntents } from '../../../packages/core/src/module-commands.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Client, Events, MessageFlags, Options, PermissionFlagsBits, type GuildChannel } from 'discord.js';
import { openStorage } from '../../../packages/db/src/factory.js';
import type { Config } from '../../../packages/core/src/config.js';
import { accessFor, HttpError } from '../../../packages/core/src/access.js';
import { ModuleHost } from '../../../packages/core/src/host.js';
import { LoggingRepository } from '../../../modules/logging/bot/repository.js';
import { DeliveryWorker } from '../../../modules/logging/bot/delivery.js';
import { botRegistry } from '../../../registry/bot.js';
import { channelData, discordTransport, destinationPermissions } from './discord.js';
import { ActivityCollector } from '../../../modules/logging/bot/collect.js';
import { PersistentMessageCache } from '../../../modules/logging/bot/message-cache.js';
import type { LoggingSettings } from '../../../modules/logging/shared/settings.js';

export async function startBot(config: Config, token: string) {
  const db = openStorage(config), store = db.scope(config.DISCORD_GUILD_ID);
  // PocketHost applies hourly per-IP caps even to paid instances. Keep idle polling modest.
  const pocketHost = config.STORAGE_PROVIDER === 'pocketbase' && new URL(config.POCKETBASE_URL!).hostname.endsWith('.pockethost.io');
  const pollMs = pocketHost ? pocketHostPollMs : 2000;
  // Installed packages declare their intent union; changes require a reconnect.
  const client = new Client({ intents: requiredIntents(installedDefinitions(config.NODE_ENV === 'production')),
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0 }), rest: { timeout: 15000, retries: 2 } });
  const transport = discordTransport(client, store.guildId), repository = new LoggingRepository(store);
  const modules = botRegistry(repository, transport.validate, config.NODE_ENV === 'production');
  await store.initialize(config.COMMUNITY_NAME, modules);
  let stopped = false, ready = false, initialized = false, sequence = 0, dropped = 0;
  let lastStorageSuccess = 0;
  let reportedFailures = 0;
  let missingMemberBaselines = 0;
  let activeTick: Promise<void> = Promise.resolve();
  const generation = randomUUID();
  const host = new ModuleHost(store.guildId, modules, store, { info: console.info, error: console.error }, async module => {
    if (!client.isReady()) throw new Error('Discord is not ready.');
    const guild = await client.guilds.fetch(store.guildId), member = await guild.members.fetchMe();
    const permissions = module.manifest.requiredBotPermissions.map(p => PermissionFlagsBits[p as keyof typeof PermissionFlagsBits]);
    if (!member.permissions.has(permissions)) throw new Error('The bot lacks required module permissions.');
  });
  const worker = new DeliveryWorker(repository, transport);
  const activity = new ActivityCollector({
    guildId: store.guildId, botId: () => client.user?.id, settings: () => host.activeSettings('logging') as LoggingSettings | null,
    channel(id) {
      const channel = client.channels.cache.get(id);
      if (!channel || !('guild' in channel) || channel.guild.id !== store.guildId) return null;
      if (channel.isThread() && !channel.parent) return null;
      return channel.isThread() ? { parentId: channel.parent?.parentId ?? null, containerId: channel.parentId, name: channel.name }
        : { parentId: channel.parentId, containerId: null, name: channel.name };
    },
    member(id) {
      const member = client.guilds.cache.get(store.guildId)?.members.cache.get(id);
      return member && !member.partial ? { nickname: member.nickname, roles: [...member.roles.cache.keys()], label: member.user.globalName ?? member.user.username } : null;
    },
    voiceChannel: id => client.guilds.cache.get(store.guildId)?.voiceStates.cache.get(id)?.channelId ?? null,
    emit(event) { void host.dispatch(event).catch(() => { dropped++; }); },
    missingMemberBaseline() { missingMemberBaselines++; }
  });
  const messageCache = new PersistentMessageCache(store, activity);
  client.on(Events.Raw, packet => {
    // Resumed sessions replay messages before ShardResume. Keep the baseline and consume that replay.
    if (stopped || !initialized) return;
    try { activity.handle(packet, `${generation}:gateway:${packet.s ?? ++sequence}`); }
    catch { dropped++; }
  });
  const release = await db.singleton(store.guildId, () => {
    ready = false; activity.clear(); client.destroy(); stopped = true; health.close(); process.exitCode = 1;
    console.error('Worker ownership lost. Shutting down the bot.');
    void (async () => {
      await activeTick.catch(() => {}); await host.stop();
      try { await release(); } finally { await db.close(); }
    })().catch(() => { console.error('Storage unavailable during worker shutdown.'); });
  });
  const health = createServer((request, response) => {
    const ok = request.url === '/health/live' || (ready && Date.now() - lastStorageSuccess < Math.max(30000, pollMs * 3));
    response.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok }));
  });
  health.listen(config.BOT_HEALTH_PORT, process.env.BOT_HEALTH_HOST ?? '127.0.0.1');
  const catalog = async () => {
    const guild = await client.guilds.fetch(store.guildId);
    const channels = await guild.channels.fetch();
    await store.replaceCatalog([...channels.values()].filter(channel => channel !== null).map(channel => ({ id: channel.id, name: channel.name, type: channel.type, parentId: channel.parentId, canSend: Boolean(channel.type === 0 && channel.permissionsFor(client.user!)?.has(destinationPermissions)) })));
  };
  const observe = (type: string, channel: GuildChannel, before: Record<string, unknown> | null, after: Record<string, unknown> | null) => {
    if (stopped || !ready || channel.guild.id !== store.guildId) return;
    void host.dispatch({ guildId: store.guildId, sourceKey: `${generation}:${++sequence}`, type, subjectId: channel.id, channelId: channel.id,
      parentId: channel.parentId, label: channel.name, observedAt: new Date().toISOString(), before, after }).catch(() => { dropped++; });
  };
  client.on(Events.ChannelCreate, channel => { if ('guild' in channel) observe('channel.created', channel, null, channelData(channel)); });
  client.on(Events.ChannelUpdate, (oldChannel, channel) => { if ('guild' in channel && 'guild' in oldChannel) observe('channel.updated', channel, channelData(oldChannel), channelData(channel)); });
  client.on(Events.ChannelDelete, channel => { if ('guild' in channel) observe('channel.deleted', channel, channelData(channel), null); });
  client.on(Events.InteractionCreate, interaction => {
    if (!interaction.isChatInputCommand()) return;
    void (async () => {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (interaction.guildId !== store.guildId || !interaction.guild) { await interaction.editReply('This bot is configured for another server.'); return; }
      const member = await interaction.guild.members.fetch({user:interaction.user.id,force:true});
      const access = accessFor(config, member.id, [...member.roles.cache.keys()], true);
      const name = `${interaction.commandName} ${interaction.options.getSubcommand()}`;
      if (name.startsWith('bot ') && !access) { await interaction.editReply('Your account does not have access to this command.'); return; }
      const text = name === 'bot dashboard' ? config.DASHBOARD_ORIGIN : name === 'bot status' ? `${config.BOT_NAME}: ${ready ? 'connected' : 'offline'}. Logging supports channels, message edits/deletions, nicknames, member roles and voice joins/leaves.` : await host.command(name, { guildId: store.guildId, userId: member.id, channelId: interaction.channelId, access, options: Object.fromEntries((interaction.options.data[0]?.options ?? []).filter(o => o.value !== undefined).map(o => [o.name, o.value!])) });
      await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
    })().catch(async () => { if (interaction.deferred) await interaction.editReply('Command unavailable. Check dashboard diagnostics.').catch(() => {}); });
  });
  client.on(Events.MessageCreate, message => {
    if (stopped || !ready || message.guildId !== store.guildId || !message.guild || message.author.bot || message.webhookId || !host.hasMessageInterest(message.channelId)) return;
    void (async () => {
      const member = await message.guild!.members.fetch({user:message.author.id,force:true});
      const access = accessFor(config, member.id, [...member.roles.cache.keys()], true);
      await host.message({ guildId: store.guildId, userId: member.id, channelId: message.channelId, access, options: {}, id: message.id, content: message.content,
        reply: async text => { await message.reply({ content: text.slice(0, 2000), allowedMentions: { parse: [], repliedUser: false } }); }
      });
    })().catch(() => { console.error('Module message dispatch failed.'); });
  });
  client.on(Events.ShardDisconnect, () => { ready = false; });
  client.on(Events.ShardResume, () => { ready = initialized; });
  client.on(Events.Error, () => { ready = false; console.error('Discord connection error. Check configuration and dashboard health.'); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cycle = new WorkerCycle(store, host, modules, {
    health: () => ({ ready, status: ready ? host.failures || dropped || missingMemberBaselines ? 'degraded' : 'online' : 'offline',
      details: { gateway: ready, persistenceFailures: host.failures, capabilities: ['channels', 'message-edits-deletions', 'member-nicknames-roles', 'voice-joins-leaves'] } }),
    messageCache, afterSync: () => activity.syncPolicy(), catalog, deliver: limit => worker.drain(limit), loggingCleanup: () => repository.cleanup(),
    async report() {
      if (host.failures > reportedFailures) { await store.incident('Observation processing failed; these observations may not have been committed.', host.failures - reportedFailures); reportedFailures = host.failures; }
      if (dropped) { await store.incident('Observation queue overflow; events were not committed.', dropped); dropped = 0; }
      if (missingMemberBaselines) { await store.incident('Member updates arrived without a previous nickname/role snapshot; changes could not be determined.', missingMemberBaselines); missingMemberBaselines = 0; }
    }
  });
  const tick = async () => {
    if (stopped) return;
    try {
      await cycle.tick();
      lastStorageSuccess = Date.now();
    } catch (error) { ready = initialized && client.isReady(); console.error('Worker tick failed.', error instanceof HttpError ? error.message : 'Storage or Discord may be unavailable.'); }
    finally { if (!stopped) timer = setTimeout(() => { activeTick = tick(); }, pollMs); }
  };
  client.on(Events.ClientReady, () => {
    void (async () => {
      ready = false; await catalog();
      await store.incident('Gateway initialized; saved message snapshots are restored, but activity during downtime and unflushed changes cannot be reconstructed.');
      await host.sync();
      if (!initialized) await messageCache.restore();
      initialized = true;
      if (client.options.intents.has('GuildMembers')) {
        try { await client.guilds.cache.get(store.guildId)?.members.fetch({ time: 15000 }); }
        catch { await store.incident('Member baseline loading was incomplete; some nickname/role changes may lack a previous snapshot.'); }
      }
      ready = true;
    })().catch(() => { console.error('Bot initialization failed. Check guild access and database.'); });
  });
  try { await client.login(token); activeTick = tick(); }
  catch { health.close(); await release(); await db.close(); client.destroy(); throw new Error('Discord login failed. Check the bot token and configured intents.'); }
  return async () => {
    stopped = true; if (timer) clearTimeout(timer); client.destroy(); health.close(); await activeTick;
    try {
      // A clean shutdown saves the remaining bounded batches before releasing worker ownership.
      for (let batch = messageCache.prepare(); batch; batch = messageCache.prepare()) {
        await store.call('workerPoll', { moduleIds: [], jobModuleIds: [], status: 'offline', details: {}, messageCache: batch });
        messageCache.acknowledge(batch);
      }
    } finally {
      activity.clear(); await host.stop();
      try { await store.heartbeat('offline', {}); } finally { await release(); await db.close(); }
    }
  };
}
