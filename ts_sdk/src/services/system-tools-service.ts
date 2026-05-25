import apiClient from '../client';
import { ScanInfo } from '../models';
import { dataManager } from '../APIEntity';
import { EventEmitter } from 'events';
import { dataContext } from '../FlowSync/context';
import { ContextEntitiesEnum } from '../FlowSync/context';
import { Project } from '../entities/project';
import { QueryRequest } from '../FlowSync/query';
import { TypeId } from '../models/TypeId';
import { connectionManager } from '../websocket';

const ACTION = 'desktop-db';
const FS_RECORDS_BASE = '/graph/compute_node/@local/fs-records';

export interface IndexTypeResult {
  indexed: number;
}

export interface IndexTypeOptions {
  /** Bypass skip-fresh so rows are re-parsed even when source mtime did not change. */
  force?: boolean;
  orphanAction?: 'index' | 'ignore' | 'delete';
}

/** Returned by `systemTools.discoverByPath()`. */
export interface DiscoverByPathResult {
  type: string;
  id: string;
  asset_ref: string;
  name?: string;
  /** Other fields per the record's `meta_dict()` shape — caller should typecast as needed. */
  [key: string]: unknown;
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

export interface ScanTypeStats {
  type: string;
  count: number;
  total_bytes: number;
  avg_bytes: number;
  scan_ms: number;
}

export interface LastScanResult {
  types: ScanTypeStats[];
  grand_total: number;
  scan_ms: number;
}

/** One row of the per-type progress table. */
export interface TypeProgressRow {
  type_name: string;
  done: number;
  total: number;
  errors: number;
  skipped: number;
}

/**
 * Snapshot of the indexer's per-type progress, mirrored from the backend's
 * ``IndexProgressTable``. Each WS event carries a complete snapshot — the
 * frontend just replaces its local copy.
 *
 * For ``index`` jobs ``total`` is the grand total of all rows (known up
 * front from the inner scan) so the UI can show ``A/B (x%)``. For ``scan``
 * jobs ``total`` is 0 (unknown — discovery IS the count); the UI shows
 * count-only.
 */
export interface IndexProgressTable {
  job_name: SystemActivity;
  rows: TypeProgressRow[];
  current: string | null;
  done: number;
  total: number;
  text: string | null;
  ts: string;
}

/**
 * SDK service for system-level data management.
 *
 * Extends EventEmitter and maintains reactive state:
 *   - `currentActivity` — which activity is running (null = idle)
 *   - `progressTable` — latest IndexProgressTable snapshot from the backend
 *   - `scanInfo` — mirrors dataManager.scanInfo, updated automatically
 *
 * Emits `'state_changed'` whenever any of the above fields change.
 * Use `useSystemTools()` hook in React components to subscribe.
 */
export class SystemToolsService extends EventEmitter {
  private readonly base: string;
  private _progressEmitPending = false;
  /** ms since epoch of the most recent WS progress event. */
  private _lastProgressAt = 0;
  /** Active idle-watchdog handle. */
  private _idleWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Pending phase-complete → null transition. Cancelled when the next phase
   *  starts before the timer fires, so resetAndRescan's archive→clear→scan→index
   *  hand-off doesn't briefly drop the indicator to idle between phases. */
  private _completionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Idle threshold: how long without a WS event before we ask the backend. */
  private static readonly _IDLE_TIMEOUT_MS = 5000;

  currentActivity: SystemActivity | null = null;
  progressTable: IndexProgressTable | null = null;
  scanInfo: ScanInfo | null = null;
  lastScanResult: LastScanResult | null = null;

  constructor(userTypeId: { type: string; id: string }) {
    super();
    this.base = `/graph/${userTypeId.type}/${userTypeId.id}/${ACTION}`;
    // Restore any in-flight scan/index state across page loads (fire-and-forget).
    // Lets the footer indexing indicator and progress modal reappear after refresh.
    void this.refreshActivityStatus().catch(() => {/* ignore — offline/boot race */});
    // Keep scanInfo in sync with dataManager
    dataManager.onScanInfoChange((info) => {
      this.scanInfo = info;
      this.emit('state_changed');
    });
    // Subscribe to progress_report flow_data events. Each event is a complete
    // IndexProgressTable snapshot — replace state wholesale, no merging.
    connectionManager.on('on_flow_data', (_typeId: unknown, flowData: Record<string, unknown>) => {
      if (flowData?.element_type !== 'progress_report') return;
      const attrs = flowData?.attributes as IndexProgressTable | undefined;
      if (!attrs?.job_name) return;

      // Drop late events for a phase we've already moved past. Without this
      // guard, a stale `complete` event for the previous phase (archive's
      // complete-WS arriving after we've already set _setActivity('clear'))
      // would overwrite currentActivity back, then the 2 s timer would null
      // the indicator mid-rescan — visible flicker between phases.
      if (this.currentActivity != null && this.currentActivity !== attrs.job_name) {
        return;
      }

      this._lastProgressAt = Date.now();
      this._armIdleWatchdog();

      this.currentActivity = attrs.job_name;
      this.progressTable = attrs;

      // Terminal event: text="complete" is the authoritative signal that the
      // job is done. The delay must be long enough that an in-flight phase
      // HTTP (e.g. clear-index can run >500 ms past its complete-event)
      // returns and calls _setActivity('next-phase') before this timer fires.
      // If the next phase arrives in time, `_setActivity` cancels the timer.
      if (attrs.text === 'complete') {
        const finishedJob = attrs.job_name;
        if (this._completionTimer != null) clearTimeout(this._completionTimer);
        this._completionTimer = setTimeout(() => {
          this._completionTimer = null;
          if (this.currentActivity === finishedJob) {
            this._setActivity(null);
            void dataManager.refreshScanInfo();
          }
        }, 2000);
      }

      this._emitProgressThrottled();
    });
  }

  /**
   * Idle watchdog: if a job is supposedly running but no WS progress event
   * has arrived in `_IDLE_TIMEOUT_MS`, query the backend's `/activity-status`
   * to settle. This is the safety net for the case where the WS dropped the
   * final completion event and we'd otherwise stay stuck mid-progress.
   */
  private _armIdleWatchdog(): void {
    if (this._idleWatchdog != null) return;
    const tick = (): void => {
      this._idleWatchdog = null;
      if (this.currentActivity == null) return;
      const elapsed = Date.now() - this._lastProgressAt;
      if (elapsed < SystemToolsService._IDLE_TIMEOUT_MS) {
        // Activity arrived since the timer was set — re-arm.
        this._armIdleWatchdog();
        return;
      }
      // No events for a while; ask the backend whether the job is really done.
      void this.refreshActivityStatus().catch(() => {/* keep going */}).then(() => {
        // If the backend said "still running", refreshActivityStatus() will
        // have re-seeded state (which counts as a synthetic progress arrival).
        if (this.currentActivity != null) this._armIdleWatchdog();
      });
    };
    this._idleWatchdog = setTimeout(tick, SystemToolsService._IDLE_TIMEOUT_MS);
  }

  private _clearIdleWatchdog(): void {
    if (this._idleWatchdog != null) {
      clearTimeout(this._idleWatchdog);
      this._idleWatchdog = null;
    }
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

  private _setActivity(activity: SystemActivity | null): void {
    this.currentActivity = activity;
    if (activity == null) {
      // Keep the last progressTable across the inter-phase boundary of a
      // resetAndRescan (archive→clear→scan→index). All consumers gate on
      // `currentActivity && progressTable` before reading, so a truly-idle
      // strip stays hidden; the retained table only matters for the <100 ms
      // window before the next phase's first WS event replaces it.
      this._clearIdleWatchdog();
    } else {
      // Phase hand-off: cancel any pending completion-timer from the previous
      // phase so it doesn't fire a stale _setActivity(null) and blink the
      // indicator to idle between scan→index etc.
      if (this._completionTimer != null) {
        clearTimeout(this._completionTimer);
        this._completionTimer = null;
      }
      // Treat the explicit phase change as a recent "event" so the watchdog
      // doesn't misfire just because no WS message has arrived yet.
      this._lastProgressAt = Date.now();
      this._armIdleWatchdog();
    }
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

  /**
   * Fetch the in-flight scan/index activity from the backend and re-seed state.
   *
   * Called after a page refresh so the rebuild-index progress modal can reopen
   * mid-job. Backend returns the latest IndexProgressTable plus
   * ``started_at``, or null when idle.
   */
  async refreshActivityStatus(): Promise<SystemActivity | null> {
    try {
      const data = await apiClient.get<
        (IndexProgressTable & { started_at: string }) | null
      >(`${FS_RECORDS_BASE}/activity-status`);

      if (!data) {
        if (this.currentActivity !== null) this._setActivity(null);
        return null;
      }

      // Set progressTable directly, then route the phase through _setActivity
      // so the idle-watchdog arms. Without that arming, if the backend has
      // advanced past data.job_name by the time we get here, the drop-late-
      // events guard would silently swallow every incoming event with no
      // self-heal — the indicator would stay stuck on a stale snapshot.
      this.progressTable = data;
      this._setActivity(data.job_name);
      return data.job_name;
    } catch {
      return null;
    }
  }

  // ---- scan index (fs-records) ---------------------------------------------

  /** Index a single record type into the entity DB / FTS.
   *
   *  Optional second arg `scope` is the unified ScopeFilter ({user, projects});
   *  when present it's forwarded as `?user=…&projects=…` so the indexer
   *  narrows its walk to the matching roots. Omit to run a full scan.
   */
  async indexType(
    typeName: string,
    scope?: { user: boolean; projects: string[] },
    options?: IndexTypeOptions,
  ): Promise<IndexTypeResult> {
    const qs = new URLSearchParams({ type: typeName });
    if (scope) {
      qs.set('user', scope.user ? 'true' : 'false');
      qs.set('projects', scope.projects.join(','));
    }
    if (options?.force) qs.set('force', 'true');
    if (options?.orphanAction) qs.set('orphan_action', options.orphanAction);
    const res = await apiClient.post<IndexTypeResult>(
      `${FS_RECORDS_BASE}/index?${qs.toString()}`,
    );
    void dataManager.refreshScanInfo();
    return res as unknown as IndexTypeResult;
  }

  /**
   * Discover-or-recover a single record by absolute path.
   *
   * POSTs to `/fs-records/{type}/discover?path=...`. The backend scans
   * just this one file (not the whole type), syncs it to the entity DB
   * if missing, and returns the entity metadata.
   *
   * Used by `useEntityByPath` to recover when the bulk list query misses
   * (file just created, or backend hasn't auto-scanned yet).
   *
   * Throws if the path doesn't exist on disk or doesn't match the type's
   * discovery rules — caller should treat that as a terminal "not found"
   * state, not a transient error.
   */
  async discoverByPath(typeName: string, path: string): Promise<DiscoverByPathResult> {
    const url =
      `${FS_RECORDS_BASE}/${encodeURIComponent(typeName)}` +
      `/discover?path=${encodeURIComponent(path)}`;
    const res = await apiClient.post<DiscoverByPathResult>(url);
    void dataManager.refreshScanInfo();
    return res as unknown as DiscoverByPathResult;
  }

  /** Sequentially index the supplied types. Each per-type call drives its own backend progressTable snapshots. */
  async indexTypes(
    types: string[],
    onProgress?: (done: string[], current: string, pending: string[]) => void,
  ): Promise<Record<string, number>> {
    const results: Record<string, number> = {};
    const done: string[] = [];
    const pending = [...types];

    this._setActivity('index');

    try {
      for (const typeName of types) {
        pending.splice(pending.indexOf(typeName), 1);
        onProgress?.(done, typeName, [...pending]);
        try {
          const res = await this.indexType(typeName);
          results[typeName] = res.indexed ?? 0;
        } catch {
          results[typeName] = 0;
        }
        done.push(typeName);
      }
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
   * Compound reset + rescan — full reindex from scratch.
   *
   *   1. Archive (DB + records snapshot)
   *   2. Clear index (FTS + all anonymous entities; @local is preserved)
   *   3. Aggregate scan — backend streams IndexProgressTable snapshots
   *   4. Aggregate index — backend streams IndexProgressTable snapshots
   *
   * The whole flow is intentionally unscoped: clear-index wipes every
   * anonymous entity (no scope kwarg accepted), so the project ids the
   * caller might pass for narrowing the scan/index would all refer to rows
   * that were just deleted — scan's project-id-to-mount-path lookup would
   * 404 ("Project '<id>' not found") and abort the rebuild. The scan
   * rediscovers projects from disk; downstream UI re-resolves via bootstrap.
   *
   * Each phase's backend WS feed drives ``progressTable`` directly; we just
   * flag the local ``currentActivity`` so the footer label phases through
   * Archiving → Clearing → Scanning → Indexing.
   */
  async resetAndRescan(): Promise<void> {
    let capturedScanResult: LastScanResult | null = null;
    try {
      this._setActivity('archive');
      await apiClient.post<ArchiveResult>(`${this.base}/archive`);

      this._setActivity('clear');
      await apiClient.post<ClearIndexResult>(`${this.base}/clear-index`, {});
      void dataManager.refreshScanInfo();

      this._setActivity('scan');
      const scanData = await apiClient.get(
        `${FS_RECORDS_BASE}/scan?trigger=manual`,
      );
      const scanResult = scanData as unknown as LastScanResult;
      if (scanResult?.types) capturedScanResult = scanResult;

      this._setActivity('index');
      await apiClient.post(`${FS_RECORDS_BASE}/index?_=1`);
    } finally {
      if (capturedScanResult) this.lastScanResult = capturedScanResult;
      this._setActivity(null);
      void dataManager.refreshScanInfo();
    }
  }

  /**
   * Incremental "fast scan": POST /fs-records/index with no archive/clear.
   *
   * Skip-fresh in the indexer means only files whose mtime > entity.updated_date
   * get re-parsed. Footer indicator + ActivityProgressModal react automatically
   * via the existing WS progress_report path. The backend `index_end` event
   * settles state on completion; the idle watchdog covers WS-loss.
   */
  async fastScan(): Promise<void> {
    this._setActivity('index');
    try {
      await apiClient.post(`${FS_RECORDS_BASE}/index`);
      void dataManager.refreshScanInfo();
    } finally {
      // The WS `index_end` event normally clears state; this is a safety net
      // for the request-failed case where no terminal event will fire.
      if (this.currentActivity === 'index') this._setActivity(null);
    }
  }

  /**
   * Project-scoped fast scan: indexer walks only the project's
   * `fs_storage_mount_path` subtree (one REAL_PROJECT_CWD root). Same
   * skip-fresh + WS progress + index_end settle path as `fastScan()`.
   */
  async fastScanProject(projectId: string): Promise<void> {
    this._setActivity('index');
    try {
      await apiClient.post(
        `${FS_RECORDS_BASE}/index?project_id=${encodeURIComponent(projectId)}`,
      );
      void dataManager.refreshScanInfo();
    } finally {
      if (this.currentActivity === 'index') this._setActivity(null);
    }
  }

  /**
   * Project-scoped hard refresh: same single-root walk as fastScanProject,
   * but with `force=true` so skip-fresh is bypassed and every file under the
   * project's mount path is re-parsed and re-upserted. Other projects' data
   * is untouched (no global archive, no global delete).
   */
  async hardRefreshProject(projectId: string): Promise<void> {
    this._setActivity('index');
    try {
      await apiClient.post(
        `${FS_RECORDS_BASE}/index?project_id=${encodeURIComponent(projectId)}&force=true`,
      );
      void dataManager.refreshScanInfo();
    } finally {
      if (this.currentActivity === 'index') this._setActivity(null);
    }
  }

  // ---- DB path setting -----------------------------------------------------

  async setDbPath(dbPath: string): Promise<DbSettings> {
    return apiClient.post<DbSettings>(`${this.base}/db-settings`, { db_path: dbPath });
  }

  // ---- project context resolution ------------------------------------------

  /**
   * Resolve workdir → project using longest-match on fs_storage_mount_path.
   * Sets CurrentProjectTypeId in dataContext.
   * If entity is provided and lacks project_id, writes the resolved id back and saves.
   */
  async resolveProjectContext(
    workdir: string | undefined,
    entity?: { project_id?: string | null; save: () => Promise<void> },
  ): Promise<void> {
    if (!workdir) return;
    const projects = await Project.query<Project>(new QueryRequest({ type: Project.type, scope: [] }));
    const candidates = projects.filter(
      (p) => p.fs_storage_mount_path && workdir.startsWith(p.fs_storage_mount_path),
    );
    const match = candidates.sort(
      (a, b) => (b.fs_storage_mount_path?.length ?? 0) - (a.fs_storage_mount_path?.length ?? 0),
    )[0];
    if (match) {
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, match.typeId);
      if (entity && !entity.project_id) {
        entity.project_id = match.id;
        await entity.save();
      }
    }
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
