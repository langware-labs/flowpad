import apiClient from '../client';
import { ScanInfo } from '../models';
import { dataManager } from '../APIEntity';
import { EventEmitter } from 'events';
import { connectionManager } from '../websocket';

const ACTION = 'desktop-db';
const FS_RECORDS_BASE = '/graph/compute_node/@local/fs-records';
const SCAN_SKIP_TYPES = new Set(['claude_debug_log']);

export interface IndexTypeResult {
  indexed: number;
}

export interface DatabasePaths {
  db_path: string;
  backup_folder: string;
  db_folder: string;
  logs_folder: string;
}

export interface EntityTypeCount {
  type: string;
  count: number;
}

export interface DatabaseStats {
  file_size_bytes: number;
  total_entities: number;
  total_relationships: number;
  entity_types: EntityTypeCount[];
}

export interface BackupResult {
  backup_path: string;
  message: string;
}

export interface ClearAllResult {
  backup_path: string;
  message: string;
}

export interface ClearIndexResult {
  fts_cleared: number;
  entities_cleared: number;
}

export interface ArchiveResult {
  archive_path: string;
  message: string;
}

export interface RestoreResult {
  message: string;
}

export interface DbSettings {
  db_path: string;
  default_path: string;
}

/** The five distinct system activities. */
export type SystemActivity = 'clear' | 'archive' | 'load_from_archive' | 'scan' | 'index';

/** Per-step progress for multi-step activities (scan / index). */
export interface ActivityProgress {
  // Orchestration-level (set by resetAndRescan phases)
  total: number;
  done: string[];
  current: string | null;
  pending: string[];
  counts?: Record<string, number>;

  // Sub-activity level (progress_report with sub_activity_name set)
  /** Records processed within the current type. */
  recordsDone?: number;
  /** Total records in the current type. */
  recordsTotal?: number;
  /** Records skipped within the current type. */
  recordsSkipped?: number;
  /** Record errors within the current type. */
  recordsErrors?: number;

  // Job level (progress_report with sub_activity_name=null)
  /** Number of types completed (from job-level WS event). */
  jobDone?: number;
  /** Total number of types (from job-level WS event). */
  jobTotal?: number;
  /** Optional status text from job-level WS event. */
  jobText?: string;
}

/**
 * SDK service for system-level data management.
 *
 * Extends EventEmitter and maintains reactive state:
 *   - `currentActivity` — which activity is running (null = idle)
 *   - `activityProgress` — per-step progress for scan/index activities
 *   - `scanInfo` — mirrors dataManager.scanInfo, updated automatically
 *
 * Emits `'state_changed'` whenever any of the above fields change.
 * Use `useSystemTools()` hook in React components to subscribe.
 */
export class SystemToolsService extends EventEmitter {
  private readonly base: string;
  private _progressEmitPending = false;

  currentActivity: SystemActivity | null = null;
  activityProgress: ActivityProgress | null = null;
  scanInfo: ScanInfo | null = null;

  constructor(userTypeId: { type: string; id: string }) {
    super();
    this.base = `/graph/${userTypeId.type}/${userTypeId.id}/${ACTION}`;
    // Keep scanInfo in sync with dataManager
    dataManager.onScanInfoChange((info) => {
      this.scanInfo = info;
      this.emit('state_changed');
    });
    // Subscribe to progress_report flow_data events from backend scan/index operations
    connectionManager.on('on_flow_data', (_typeId: unknown, flowData: Record<string, unknown>) => {
      if (flowData?.element_type !== 'progress_report') return;
      const attrs = flowData?.attributes as Record<string, unknown> | undefined;
      if (!attrs || !this.activityProgress) return;
      if (attrs.job_name !== this.currentActivity) return;

      if (attrs.sub_activity_name != null) {
        // Sub-activity event: per-record progress within a type
        const subName = attrs.sub_activity_name as string;
        const prev = this.activityProgress.current;
        const newDone =
          prev && prev !== subName
            ? [...this.activityProgress.done, prev]
            : this.activityProgress.done;
        this.activityProgress = {
          ...this.activityProgress,
          current: subName,
          done: newDone,
          recordsDone: attrs.done as number,
          recordsTotal: attrs.total as number,
          recordsSkipped: attrs.skipped as number,
          recordsErrors: attrs.errors as number,
        };
      } else {
        // Job-level event: number of types completed
        this.activityProgress = {
          ...this.activityProgress,
          jobDone: attrs.done as number,
          jobTotal: attrs.total as number,
          jobText: attrs.text as string | undefined,
        };
      }
      this._emitProgressThrottled();
    });
  }

  /** Batch rapid WS progress events to ~60fps so React renders smoothly. */
  private _emitProgressThrottled(): void {
    if (this._progressEmitPending) return;
    this._progressEmitPending = true;
    setTimeout(() => {
      this._progressEmitPending = false;
      this.emit('state_changed');
    }, 16);
  }

  private _setActivity(activity: SystemActivity | null, progress?: ActivityProgress | null): void {
    this.currentActivity = activity;
    this.activityProgress = progress ?? null;
    this.emit('state_changed');
  }

  // ---- read ----------------------------------------------------------------

  async getPaths(): Promise<DatabasePaths> {
    return apiClient.get<DatabasePaths>(`${this.base}/paths`);
  }

  async getStats(): Promise<DatabaseStats> {
    return apiClient.get<DatabaseStats>(`${this.base}/stats`);
  }

  async getDbSettings(): Promise<DbSettings> {
    return apiClient.get<DbSettings>(`${this.base}/db-settings`);
  }

  // ---- write ---------------------------------------------------------------

  /** Backup DB only (no clear). */
  async backup(): Promise<BackupResult> {
    this._setActivity('archive');
    try {
      return await apiClient.post<BackupResult>(`${this.base}/backup`);
    } finally {
      this._setActivity(null);
    }
  }

  /** Full archive: DB snapshot + records snapshot in a timestamped folder. */
  async archive(): Promise<ArchiveResult> {
    this._setActivity('archive');
    try {
      return await apiClient.post<ArchiveResult>(`${this.base}/archive`);
    } finally {
      this._setActivity(null);
    }
  }

  /**
   * Restore DB from a backup file.
   * The index is cleared automatically after restore.
   */
  async restore(backupPath: string): Promise<RestoreResult> {
    this._setActivity('load_from_archive');
    try {
      return await apiClient.post<RestoreResult>(`${this.base}/restore`, { backup_path: backupPath });
    } finally {
      this._setActivity(null);
    }
  }

  /**
   * Clear the scan index (FTS + entity records + index logs).
   * Optionally scoped to specific record types.
   */
  async clearIndex(types?: string[]): Promise<ClearIndexResult> {
    this._setActivity('clear');
    try {
      const result = await apiClient.post<ClearIndexResult>(`${this.base}/clear-index`, types ? { types } : {});
      void dataManager.refreshScanInfo();
      return result;
    } finally {
      this._setActivity(null);
    }
  }

  async getScanInfo(): Promise<ScanInfo> {
    await dataManager.refreshScanInfo();
    return dataManager.scanInfo ?? { total_indexed: 0, last_indexed_at: null, never_indexed: true, stale: false };
  }

  // ---- scan index (fs-records) ---------------------------------------------

  /** Index a single record type into the entity DB / FTS. */
  async indexType(typeName: string): Promise<IndexTypeResult> {
    const res = await apiClient.post<IndexTypeResult>(
      `${FS_RECORDS_BASE}/index?type=${encodeURIComponent(typeName)}`,
    );
    void dataManager.refreshScanInfo();
    return res as unknown as IndexTypeResult;
  }

  /** Sequentially index the supplied types, emitting per-step 'index' activity updates. */
  async indexTypes(
    types: string[],
    onProgress?: (done: string[], current: string, pending: string[]) => void,
  ): Promise<Record<string, number>> {
    const results: Record<string, number> = {};
    const done: string[] = [];
    const pending = [...types];

    this._setActivity('index', { total: types.length, done: [], current: null, pending: [...pending] });

    try {
      for (const typeName of types) {
        pending.splice(pending.indexOf(typeName), 1);
        this._setActivity('index', {
          total: types.length,
          done: [...done],
          current: typeName,
          pending: [...pending],
        });
        onProgress?.(done, typeName, [...pending]);
        try {
          const res = await this.indexType(typeName);
          results[typeName] = res.indexed ?? 0;
        } catch {
          results[typeName] = 0;
        }
        done.push(typeName);
      }
      this._setActivity('index', { total: types.length, done: [...types], current: null, pending: [] });
      void dataManager.refreshScanInfo();
    } finally {
      this._setActivity(null);
    }

    return results;
  }

  /**
   * Full reset: backup → clear index → wipe DB → reinitialize.
   * The server clears the index internally — callers don't need to do it separately.
   */
  async clearAllData(): Promise<ClearAllResult> {
    this._setActivity('clear');
    try {
      const result = await apiClient.post<ClearAllResult>(`${this.base}/clear`);
      void dataManager.refreshScanInfo();
      return result;
    } finally {
      this._setActivity(null);
    }
  }

  /**
   * Compound reset + rescan:
   *   1. Archive (DB + records snapshot)
   *   2. Clear index (FTS + entity records)
   *   3. Aggregate scan (backend streams progress_report WS events per record/type)
   *   4. Aggregate index (backend streams progress_report WS events per record/type)
   *
   * WS progress_report events drive the activityProgress.current / done / records fields.
   */
  async resetAndRescan(): Promise<void> {
    try {
      // 1. Archive
      this._setActivity('archive');
      await apiClient.post<ArchiveResult>(`${this.base}/archive`);

      // 2. Clear index
      this._setActivity('clear');
      await apiClient.post<ClearIndexResult>(`${this.base}/clear-index`, {});
      void dataManager.refreshScanInfo();

      // 3. Fetch registered types to seed the pending list (so UI shows names before WS events)
      const typesData = await apiClient.get<{ types: string[] }>(FS_RECORDS_BASE);
      const types = ((typesData as unknown as { types: string[] }).types ?? []).filter(
        (t) => !SCAN_SKIP_TYPES.has(t),
      );

      // 4. Aggregate scan — WS progress_report events drive current/done/records progress
      this._setActivity('scan', { total: types.length, done: [], current: null, pending: [...types] });
      await apiClient.get(`${FS_RECORDS_BASE}/scan?trigger=manual`);

      // 5. Aggregate index — WS progress_report events drive current/done/records progress
      this._setActivity('index', { total: types.length, done: [], current: null, pending: [...types] });
      await apiClient.post(`${FS_RECORDS_BASE}/index`);
    } finally {
      this._setActivity(null);
      void dataManager.refreshScanInfo();
    }
  }

  // ---- DB path setting -----------------------------------------------------

  async setDbPath(dbPath: string): Promise<DbSettings> {
    return apiClient.post<DbSettings>(`${this.base}/db-settings`, { db_path: dbPath });
  }

  // ---- OS folder openers ---------------------------------------------------

  async openBackupFolder(): Promise<void> {
    await apiClient.post(`${this.base}/open-backup`);
  }

  async openDbFolder(): Promise<void> {
    await apiClient.post(`${this.base}/open-db`);
  }

  async openLogsFolder(): Promise<void> {
    await apiClient.post(`${this.base}/open-logs`);
  }
}

/**
 * Ready-to-use singleton pre-configured for the local compute node (@local).
 *
 * import { systemTools } from '@sdk';
 * await systemTools.clearAllData();
 * await systemTools.clearIndex();
 * await systemTools.backup();
 * await systemTools.archive();
 * await systemTools.restore(backupPath);
 * await systemTools.resetAndRescan();
 */
export const systemTools = new SystemToolsService({ type: 'compute_node', id: '@local' });
