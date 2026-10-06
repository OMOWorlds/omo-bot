import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PocketBaseAdapter } from '../packages/db/src/pocketbase.js';
import { WorkerCycle, pocketHostPollMs } from '../packages/core/src/worker-cycle.js';
import { ModuleHost } from '../packages/core/src/host.js';
import { botRegistry } from '../registry/bot.js';
import { LoggingRepository } from '../modules/logging/bot/repository.js';
import { DeliveryWorker } from '../modules/logging/bot/delivery.js';
import { defaultLoggingSettings, type LogEvent } from '../modules/logging/shared/settings.js';
import type { ModuleState } from '../packages/module-sdk/src/browser.js';
import type { DeliveryClaim, Operations, SessionRecord } from '../packages/db/src/contracts.js';
import { createServer } from '../apps/web/src/server.js';
import { readConfig } from '../packages/core/src/config.js';
import { ActivityCollector } from '../modules/logging/bot/collect.js';
import { PersistentMessageCache } from '../modules/logging/bot/message-cache.js';
import type { GatewayDispatchPayload } from 'discord.js';

// Count actual serialized HTTP requests through the production adapter, not SQL calls or source estimates.
// In-memory responses model the server; real database semantics are covered by providers.test.ts.
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it.each([1, 2])('budgets a full idle hour with %i installed modules including independent lease renewals', async count => {
  const result = await workload(count, 0, false);
  expect(result.calls.workerPoll).toBe(120);
  expect(result.calls.leaseRenew).toBe(180);
  expect(result.calls.catalogReplace).toBe(13); // startup plus twelve maintenance refreshes
  expect(result.calls.cleanup).toBe(1);
  expect(result.calls.loggingCleanup).toBe(1);
  expect(result.calls.jobClaim ?? 0).toBe(0);
  expect(result.calls.deliveryPrepare ?? 0).toBe(0);
  expect(result.total).toBeLessThan(350);
  console.info(`PocketHost budget: ${count} installed modules, idle hour = ${result.total} HTTP requests (startup/shutdown included).`);
});
it('fits 100 delivered changes and one continuously open overview within the standard hourly allowance', async () => {
  const result = await workload(2, 100, true);
  expect(result.sent).toBe(100);
  expect(result.calls.eventCapture).toBe(100);
  expect(result.calls.deliveryPrepare).toBe(100);
  expect(result.calls.deliveryVerify).toBe(100);
  expect(result.calls.deliveryFinish).toBe(100);
  expect(result.calls.dashboardSnapshot).toBe(60);
  expect(result.calls.sessionGet).toBe(60);
  expect(result.calls.sessionRefresh).toBe(59);
  expect(result.calls.sessionTouch ?? 0).toBe(0);
  expect(result.total).toBeLessThan(1000);
  expect(result.peakBurst).toBeLessThanOrEqual(50);
  console.info(`PocketHost budget: 100 changes plus one overview = ${result.total} HTTP requests; maximum rolling 10-second burst = ${result.peakBurst}.`);
});
it('persists 1,000 ordinary messages through existing polls without adding per-message requests', async () => {
  const result = await workload(1, 0, false, 1000);
  expect(result.cached).toBe(1000);
  expect(result.calls.messageCacheLoad).toBe(1);
  expect(result.calls.workerPoll).toBe(120);
  expect(result.calls.eventCapture ?? 0).toBe(0);
  expect(result.total).toBeLessThan(350);
});

async function workload(moduleCount: number, changes: number, dashboard: boolean, messages = 0) {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const guild = '100000000000000001', destination = '100000000000000010';
  const settings = { ...defaultLoggingSettings, destinationId: destination };
  const states = new Map<string, ModuleState>();
  const events: LogEvent[] = [], pending: Array<{ event: LogEvent; delivery: DeliveryClaim }> = [];
  let session: SessionRecord | null = null, sent = 0;
  const cached = new Set<string>();
  const calls: Record<string, number> = {}, times: number[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const name = _url.split('/').pop() as keyof Operations;
    const { input } = JSON.parse(init.body as string);
    calls[name] = (calls[name] ?? 0) + 1; times.push(Date.now());
    let data: unknown = null;
    switch (name) {
      case 'ready': data = { protocol: 1, trafficProtocol: 1, secretsProtocol: 1, messageCacheProtocol: 1 }; break;
      case 'initialize': for (const module of input.modules) if (!states.has(module.id)) states.set(module.id, {
        moduleId: module.id, settingsVersion: module.settingsVersion, enabled: module.id === 'logging', appliedEnabled: module.id === 'logging',
        settings: module.id === 'logging' ? settings : module.settings, appliedSettings: module.id === 'logging' ? settings : module.settings,
        desiredRevision: 2, appliedRevision: 2, applyError: null
      }); break;
      case 'moduleGet': data = states.get(input.id); break;
      case 'workerPoll':
        for (const id of input.messageCache?.deletes ?? []) cached.delete(id);
        for (const entry of input.messageCache?.upserts ?? []) cached.add(entry.id);
        data = { modules: input.moduleIds.map((id: string) => states.get(id)), jobsDue: false, deliveriesDue: Math.min(pending.length, 5) }; break;
      case 'messageCacheLoad': data = { records: [], nextCursor: null }; break;
      case 'leaseAcquire': case 'leaseRenew': case 'deliveryVerify': data = true; break;
      case 'eventCapture': {
        const event: LogEvent = { id: randomUUID(), type: input.event.type, subjectId: input.event.subjectId, subjectLabel: input.event.label, channelId: input.event.channelId,
          parentId: null, observedAt: input.event.observedAt, before: input.event.before, after: input.event.after, actorId: null, reason: null, attribution: 'unknown', configRevision: input.revision,
          expiresAt: new Date(Date.now() + 86400000).toISOString(), deliveryState: 'pending', destinationId: destination, messageId: null };
        events.push(event); pending.push({ event, delivery: { id: randomUUID(), event_id: event.id, destination_id: destination, marker: event.id, attempts: 1, created_at: event.observedAt, claim_token: randomUUID() } }); break;
      }
      case 'deliveryPrepare': { const next = pending.shift(); data = next ? { ...next, module: states.get('logging') } : null; break; }
      case 'dashboardSnapshot': data = { modules: [...states.values()], events: events.slice(-5), status: { health: null, queue: [], incidents: [], eventCount: events.length } }; break;
      case 'sessionCreate': session = { ...input, checked_at: new Date().toISOString() }; break;
      case 'sessionGet': data = session; break;
      case 'sessionRefresh': session = { ...session!, tokens: input.tokens, access: input.access, checked_at: new Date().toISOString() }; break;
      case 'heartbeat': case 'moduleAcknowledge': case 'loggingApply': case 'loggingCancel': case 'catalogReplace': case 'incident': case 'cleanup': case 'loggingCleanup': case 'leaseRelease': case 'deliveryFinish': break;
      default: throw new Error(`Uncounted storage operation: ${name}`);
    }
    return new Response(JSON.stringify({ data }));
  }));
  const db = new PocketBaseAdapter('https://test.pockethost.io', 'a'.repeat(64)), store = db.scope(guild), repo = new LoggingRepository(store);
  const modules = botRegistry(repo, async () => {}, moduleCount === 1);
  expect(modules).toHaveLength(moduleCount);
  await store.initialize('Test', modules);
  const lost = vi.fn(), release = await db.singleton(guild, lost);
  const host = new ModuleHost(guild, modules, store, { info() {}, error() {} });
  const worker = new DeliveryWorker(repo, { async validate() {}, async find() { return null; }, async send() { sent++; return destination; } });
  const collector = new ActivityCollector({ guildId: guild, botId: () => destination, settings: () => settings,
    channel: () => ({ parentId: null, containerId: null }), member: () => null, voiceChannel: () => null, emit() {}, missingMemberBaseline() {} });
  const messageCache = new PersistentMessageCache(store, collector);
  const cycle = new WorkerCycle(store, host, modules, { messageCache, health: () => ({ ready: true, status: 'online', details: {} }), afterSync() {},
    catalog: () => store.replaceCatalog([]), report: async () => {}, deliver: limit => worker.drain(limit), loggingCleanup: () => repo.cleanup() });
  // Same one-off storage work as the ready handler, in addition to the maintenance loop.
  await store.replaceCatalog([]); await store.incident('Gateway initialized'); await host.sync();
  await messageCache.restore();
  const server = dashboard ? await createServer({ db, config: readConfig({ NODE_ENV: 'test', STORAGE_PROVIDER: 'pocketbase', DISCORD_GUILD_ID: guild,
    OWNER_USER_IDS: '100000000000000002', POCKETBASE_URL: 'https://test.pockethost.io', POCKETBASE_SERVICE_KEY: 'a'.repeat(64), DASHBOARD_ORIGIN: 'http://localhost:3000' }),
    demo: true, clientId: 'fixture', encryptionKey: 'b'.repeat(64), identity: { async exchange() { throw new Error('unused'); }, async identity() { throw new Error('unused'); }, async membership(tokens) { return { tokens, roles: [] }; } } }) : null;
  const login = server ? await server.app.inject({ method: 'GET', url: '/auth/demo' }) : null;
  const cookie = login?.cookies[0];
  try {
    for (let tick = 0; tick < 120; tick++) {
      for (let i = tick * 10; i < Math.min(messages, (tick + 1) * 10); i++) collector.handle({ op: 0, s: i, t: 'MESSAGE_CREATE', d: {
        guild_id: guild, channel_id: '100000000000000031', id: String(100000000000001000n + BigInt(i)), author: { id: '100000000000000002', username: 'Member' }, content: 'Ordinary message', attachments: []
      } } as unknown as GatewayDispatchPayload, `message-${i}`);
      if (tick < changes) await host.dispatch({ guildId: guild, sourceKey: `change-${tick}`, type: 'channel.created', subjectId: '100000000000000030', channelId: '100000000000000030', parentId: null,
        label: 'New channel', observedAt: new Date().toISOString(), before: null, after: { name: 'New channel' } });
      await cycle.tick();
      if (server && tick % 2 === 0) {
        const response = await server.app.inject({ method: 'GET', url: '/api/workspace', cookies: { omo_session: cookie!.value } });
        expect(response.statusCode).toBe(200);
      }
      await vi.advanceTimersByTimeAsync(pocketHostPollMs);
    }
    expect(lost).not.toHaveBeenCalled();
  } finally { await server?.app.close(); await host.stop(); await store.heartbeat('offline', {}); await release(); await db.close(); }
  return { calls, sent, cached: cached.size, total: times.length, peakBurst: Math.max(...times.map(time => times.filter(other => other >= time && other < time + 10000).length)) };
}
