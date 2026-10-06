import { ModuleSecrets } from '../../core/src/secret-vault.js';
import { moduleResources, upgradeSettings } from './module-resources.js';
import type { StorageDriver, Operations } from './contracts.js';
import type { ModuleDefinition } from '../../module-sdk/src/server.js';
import type { ModuleState, CatalogChannel } from '../../module-sdk/src/browser.js';
export type { StorageDriver, Operations } from './contracts.js';
export { PostgresAdapter as Database } from './postgres-adapter.js';

/** All callers supply a server-selected guild; drivers enforce that scope again. */
export class GuildStore {
  constructor(readonly db: StorageDriver, readonly guildId: string) {}
  call<K extends keyof Operations>(operation: K, input: Operations[K]['input']): Promise<Operations[K]['output']> { return this.db.call(this.guildId, operation, input); }
  async ready() {
    const status = await this.call('ready', {});
    if (status?.trafficProtocol !== 1) throw new Error('Update the PocketBase storage hooks before starting this version (traffic protocol 1 required).');
    if (status.secretsProtocol !== 1) throw new Error('Update PocketBase hooks and migrations before starting this version (secrets protocol 1 required).');
    if (status.messageCacheProtocol !== 1) throw new Error('Update PocketBase storage hooks before starting this version (message cache protocol 1 required).');
  }
  async initialize(displayName: string, modules: ModuleDefinition[]) { await this.ready(); await this.call('initialize', { displayName, modules: modules.map(m => ({ id: m.manifest.id, settings: m.defaultSettings, settingsVersion: m.manifest.settingsVersion })) }); for (const module of modules) await upgradeSettings(this, module); }
  secrets(module: ModuleDefinition) { return new ModuleSecrets(this, module); }
  resources(moduleId: string) { return moduleResources(this, moduleId); }
  getModule(id: string) { return this.call('moduleGet', { id }); }
  updateModule(id: string, expected: number, actor: string, change: { settings?: unknown; enabled?: boolean }) { return this.call('moduleUpdate', { id, expected, actor, change }); }
  async acknowledge(id: string, state: ModuleState) { await this.call('moduleAcknowledge', { id, state }); }
  async reject(id: string, revision: number, message: string) { await this.call('moduleReject', { id, revision, message }); }
  catalog() { return this.call('catalogGet', {}); }
  async replaceCatalog(channels: CatalogChannel[]) { await this.call('catalogReplace', { channels }); }
  async heartbeat(status: string, details: Record<string, unknown>) { await this.call('heartbeat', { status, details }); }
  async incident(reason: string, count: number | null = null) { await this.call('incident', { reason, count }); }
  enqueueJob(moduleId: string, type: string, payload: unknown, key: string) { return this.call('jobEnqueue', { moduleId, type, payload, key }); }
  async cleanup() { await this.call('cleanup', {}); }
}
