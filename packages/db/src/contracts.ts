import type { ModuleRecord, RecordPage, JobOptions } from '../../module-sdk/src/services.js';
import type { Access, CatalogChannel, ModuleState } from '../../module-sdk/src/browser.js';
import type { Observation } from '../../module-sdk/src/server.js';
import type { LoggingSettings, LogEvent } from '../../../modules/logging/shared/settings.js';
import type { MessageCacheBatch } from '../../../modules/logging/shared/message-cache.js';

export interface SecretRecord { mode: 'stored' | 'disabled' | 'environment'; ciphertext: string | null; revision: number }
export interface SessionRecord {
  id_hash: string; user_id: string; label: string; tokens: string; csrf_hash: string;
  checked_at: string | null; access: Access | null;
}
export interface JobRecord { id: string; module_id: string; payload: unknown; attempts: number; type: string; state: string; result: { message: string } | null; error: string | null; expires_at: string; claim_token: string | null }
export interface DeliveryClaim { id: string; event_id: string; destination_id: string; marker: string; attempts: number; created_at: string; claim_token: string }
export interface StorageStatus {
  health: { heartbeat: string; status: string; details: Record<string, unknown> } | null;
  queue: { state: string; count: number; oldest: string }[];
  incidents: { id: string; started_at: string; reason: string; dropped_count: number | null }[];
  eventCount: number;
}
export interface EventFilter { type?: string; subject?: string; cursor?: string; limit: number }
type Op<I, O> = { input: I; output: O };
export interface Operations {
  ready: Op<Record<string, never>, { protocol: 1; trafficProtocol?: 1; secretsProtocol?: 1; messageCacheProtocol?: 1 }>;
  workerPoll: Op<{ moduleIds: string[]; jobModuleIds: string[]; status: string; details: Record<string, unknown>; messageCache?: MessageCacheBatch }, { modules: ModuleState[]; jobsDue: boolean; deliveriesDue: number }>;
  messageCacheLoad: Op<{ cursor: string }, RecordPage>;
  dashboardSnapshot: Op<{ moduleIds: string[] }, { modules: ModuleState[]; status: StorageStatus; events: LogEvent[] }>;
  deliveryPrepare: Op<Record<string, never>, { delivery: DeliveryClaim; event: LogEvent; module: ModuleState } | null>;
  deliveryVerify: Op<{ id: string; claimToken: string; revision: number }, boolean>;
  secretGet: Op<{ moduleId: string; name: string }, SecretRecord | null>;
  secretSet: Op<{ moduleId: string; name: string; expected: number; mode: SecretRecord['mode']; ciphertext: string | null }, SecretRecord>;
  workerVerify: Op<Record<string, never>, null>;
  initialize: Op<{ displayName: string; modules: { id: string; settings: unknown; settingsVersion: number }[] }, null>;
  moduleUpgrade: Op<{ id: string; expected: number; fromVersion: number; toVersion: number; settings: unknown }, ModuleState>;
  recordGet: Op<{ moduleId: string; key: string }, ModuleRecord | null>;
  recordList: Op<{ moduleId: string; prefix: string; cursor: string; limit: number }, RecordPage>;
  recordPut: Op<{ moduleId: string; key: string; value: unknown; expected: number; ttlMs?: number }, ModuleRecord>;
  recordDelete: Op<{ moduleId: string; key: string; expected: number }, boolean>;
  moduleGet: Op<{ id: string }, ModuleState>;
  moduleUpdate: Op<{ id: string; expected: number; actor: string; change: { settings?: unknown; enabled?: boolean } }, ModuleState>;
  moduleAcknowledge: Op<{ id: string; state: ModuleState }, null>;
  moduleReject: Op<{ id: string; revision: number; message: string }, null>;
  catalogGet: Op<Record<string, never>, CatalogChannel[]>;
  catalogReplace: Op<{ channels: CatalogChannel[] }, null>;
  rolesGet: Op<Record<string, never>, unknown[]>;
  heartbeat: Op<{ status: string; details: Record<string, unknown> }, null>;
  incident: Op<{ reason: string; count: number | null }, null>;
  status: Op<Record<string, never>, StorageStatus>;
  jobEnqueue: Op<{ moduleId: string; type: string; payload: unknown; key: string; options?: JobOptions }, string>;
  jobGet: Op<{ id: string }, JobRecord>;
  jobClaim: Op<{ moduleIds?: string[] }, JobRecord | null>;
  jobFinish: Op<{ id: string; claimToken: string; error: string | null; message: string | null }, null>;
  cleanup: Op<Record<string, never>, null>;
  sessionCreate: Op<Omit<SessionRecord, 'checked_at'>, null>;
  sessionGet: Op<{ hash: string; touch?: boolean }, SessionRecord | null>;
  sessionRefresh: Op<{ hash: string; tokens: string; access: Access }, null>;
  sessionTouch: Op<{ hash: string }, null>;
  sessionDelete: Op<{ hash: string }, null>;
  oauthCreate: Op<{ hash: string }, null>;
  oauthConsume: Op<{ hash: string }, boolean>;
  eventCapture: Op<{ event: Observation; settings: LoggingSettings; revision: number }, null>;
  eventList: Op<EventFilter, { events: LogEvent[]; nextCursor: string | null }>;
  eventDetail: Op<{ id: string }, LogEvent>;
  loggingApply: Op<{ settings: LoggingSettings }, null>;
  loggingCancel: Op<Record<string, never>, null>;
  loggingCleanup: Op<Record<string, never>, null>;
  deliveryClaim: Op<Record<string, never>, DeliveryClaim | null>;
  deliveryFinish: Op<{ id: string; claimToken: string; state: 'sent' | 'cancelled' | 'blocked' | 'failed' | 'pending'; messageId?: string; error?: string; delayMs?: number }, null>;
  deliveryRetry: Op<{ id: string }, boolean>;
  leaseAcquire: Op<{ owner: string }, boolean>;
  leaseRenew: Op<{ owner: string }, boolean>;
  leaseRelease: Op<{ owner: string }, null>;
}
export interface StorageDriver {
  readonly kind: 'postgres' | 'pocketbase';
  call<K extends keyof Operations>(guildId: string, operation: K, input: Operations[K]['input']): Promise<Operations[K]['output']>;
  scope(guildId: string): import('./index.js').GuildStore;
  singleton(guildId: string, lost: () => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
