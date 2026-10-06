import type { GuildStore, Operations } from '../../db/src/index.js';
import type { ModuleHost } from './host.js';
import type { ModuleDefinition } from '../../module-sdk/src/server.js';
import { runModuleJobs } from './jobs.js';

export const pocketHostPollMs = 30000;
export const catalogRefreshMs = 300000;
/** Includes every recurring storage maintenance operation; the independent lease timer lives in the driver. */
export class WorkerCycle {
  private lastCatalog = -Infinity;
  private lastCleanup = -Infinity;
  constructor(private store: GuildStore, private host: ModuleHost, private modules: ModuleDefinition[], private effects: {
    health(): { ready: boolean; status: string; details: Record<string, unknown> };
    afterSync(): void;
    messageCache?: {
      prepare(): Operations['workerPoll']['input']['messageCache'];
      acknowledge(batch: NonNullable<Operations['workerPoll']['input']['messageCache']>): void;
    };
    catalog(): Promise<void>;
    report(): Promise<void>;
    deliver(limit: number): Promise<void>;
    loggingCleanup(): Promise<void>;
  }) {}
  async tick() {
    const health = this.effects.health();
    let snapshot: Operations['workerPoll']['output'] | undefined;
    await this.host.sync(async () => {
      const messageCache = this.effects.messageCache?.prepare();
      snapshot = await this.store.call('workerPoll', { moduleIds: this.modules.map(m => m.manifest.id),
        jobModuleIds: this.modules.filter(m => Object.keys(m.jobSchemas ?? {}).length > 0).map(m => m.manifest.id),
        status: health.status, details: health.details, ...(messageCache ? { messageCache } : {}) });
      if (messageCache) this.effects.messageCache?.acknowledge(messageCache);
      return snapshot.modules;
    });
    this.effects.afterSync();
    if (health.ready) {
      if (snapshot!.jobsDue) await runModuleJobs(this.store, this.host);
      if (snapshot!.deliveriesDue && this.host.activeModuleIds().includes('logging')) await this.effects.deliver(snapshot!.deliveriesDue);
      if (Date.now() - this.lastCatalog >= catalogRefreshMs) { await this.effects.catalog(); this.lastCatalog = Date.now(); }
    }
    await this.effects.report();
    if (Date.now() - this.lastCleanup >= 3600000) {
      await this.store.cleanup(); await this.effects.loggingCleanup(); this.lastCleanup = Date.now();
    }
  }
}
