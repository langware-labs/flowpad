import apiClient from '../client';
import { ScanInfo } from '../models';
import { dataManager } from '../APIEntity';
import { EventEmitter } from 'events';
import { dataContext } from '../FlowSync/context';
import { ContextEntitiesEnum } from '../FlowSync/context';
import { Project } from '../entities/project';
import { FlowpadDiagnosis } from '../entities/flowpad-diagnosis';
import { QueryRequest } from '../FlowSync/query';
import { TypeId } from '../models/TypeId';
import { connectionManager } from '../websocket';
import { scopeIncludesUser, scopeProjectIds, type ScopeFilter } from '../utils/scope-filter';
import { hubModeReady, isHubOnly } from '../utils/hub-runtime';

const ACTION = 'desktop-db';

/** HTTP status of a thrown apiClient (axios) error, if it carries one. */
function httpStatusOf(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }; status?: number } | null;
  return e?.response?.status ?? e?.status;
}
const FS_RECORDS_BASE = '/graph/compute_node/@local/fs-records';

/** The canonical ScopeFilter encoding for a single project. One spelling, so
 *  the three scoped fs-records calls in this file cannot drift. */
const projectScopeQs = (projectId: string): string =>
  new URLSearchParams({ user: 'false', projects: projectId }).toString();

export interface IndexTypeResult {
  indexed: number;
}

export interface IndexTypeOptions {
  /** Bypass skip-fresh so rows are re-parsed even when source mtime did not change. */
  force?: boolean;
  orphanAction?: 'index' | 'ignore' | 'delete';
}

/**
 * Returned by `systemTools.resolveByPath()` — the backend's classification of
 * one on-disk path (`GET /api/v1/assets/resolve?path=…`). The CLIENT sends a
 * path and gets the record type back; it never derives the type from the path.
 */
export interface ResolvedAsset {
  /** Record type the path classifies to (`'skill'`, `'markdown'`, …). */
  type: string;
  /** Entity id (minted or recovered by the backend). */
  id: string;
  /** The asset root — the folder for a folder-shaped type, the file otherwise. */
  root: string;
  /** The main body file when the shape has one (`<root>/SKILL.md`), else null. */
  body: string | null;
  /** The editor that opens this type, as the registry declares it. */
  editor: string | null;
  /** The entity row when the backend hydrated it; null when only classified. */
  entity: Record<string, unknown> | null;
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
  /** The walk's own share of `scan_ms` (the rest is scope resolution + projection). */
  walk_ms?: number;
}

export interface LastScanResult {
  types: ScanTypeStats[];
  grand_total: number;
  scan_ms: number;
  /** The walk's own share of `scan_ms` (the rest is scope resolution + projection). */
  walk_ms?: number;
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
 * Terminal marker on ``IndexProgressTable.text`` — mirrors the backend's
 * ``PROGRESS_TEXT_COMPLETE`` (flow_sdk/fs_store/indexer/progress_table.py).
 * Other text values are informational phase labels (e.g. "sweeping").
 */
export const PROGRESS_TEXT_COMPLETE = 'complete';

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

      // Terminal event: PROGRESS_TEXT_COMPLETE is the authoritative signal
      // that the job is done. The delay must be long enough that an in-flight
      // phase HTTP (e.g. clear-index can run >500 ms past its complete-event)
      // returns and calls _setActivity('next-phase') before this timer fires.
      // If the next phase arrives in time, `_setActivity` cancels the timer.
      if (attrs.text === PROGRESS_TEXT_COMPLETE) {
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
    // Wait until the hub-mode signal is known before deciding — this can fire
    // from the constructor at boot, before bootstrap seeds `supported_pages`.
    await hubModeReady();
    // Hub mode: the hub backend has no local fs-records `/activity-status`
    // (404). There's no local indexer here, so activity is always idle.
    if (isHubOnly()) {
      if (this.currentActivity !== null) this._setActivity(null);
      return null;
    }
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
    scope?: ScopeFilter,
    options?: IndexTypeOptions,
  ): Promise<IndexTypeResult> {
    const qs = new URLSearchParams({ type: typeName });
    if (scope) {
      qs.set('user', scopeIncludesUser(scope) ? 'true' : 'false');
      qs.set('projects', scopeProjectIds(scope).join(','));
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
   * Classify one absolute machine path: `GET /api/v1/assets/resolve?path=…`.
   *
   * The backend walks the path up to its asset root, names the record type,
   * mints/recovers the id, and returns the row when it has one. This is the
   * ONLY path→type seam the client uses: `useEntityByPath` keys the entity by
   * the RETURNED type/id, and `AssetEditorRouter`'s vfs branch takes its record
   * type from here instead of the editor segment.
   *
   * Resolves to null when the backend answers 404 (the path is not an asset —
   * a `.py`, a folder with no shape, a path outside every scope). Any other
   * failure throws so the caller can treat it as transient.
   */
  async resolveByPath(path: string): Promise<ResolvedAsset | null> {
    try {
      const res = await apiClient.get<ResolvedAsset>('/api/v1/assets/resolve', { params: { path } });
      return res ?? null;
    } catch (err: unknown) {
      if (httpStatusOf(err) === 404) return null;
      throw err;
    }
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
   *
   * Wire format matches the canonical ScopeFilter encoding
   * (`?user=false&projects=<id>`) so the backend takes one parse path
   * regardless of which client sent the request.
   */
  async fastScanProject(projectId: string): Promise<void> {
    this._setActivity('index');
    try {
      const qs = new URLSearchParams({ user: 'false', projects: projectId });
      await apiClient.post(`${FS_RECORDS_BASE}/index?${qs.toString()}`);
      void dataManager.refreshScanInfo();
    } finally {
      if (this.currentActivity === 'index') this._setActivity(null);
    }
  }

  /**
   * Has this project ever been indexed? One cheap scoped `index-status` read.
   *
   * Lives here rather than at the caller so the endpoint path, the scope
   * encoding, and — importantly — the hub-mode guard stay in one place: the
   * hub backend has no fs-records endpoints and 404s this, which a caller
   * rolling its own fetch would misread as "not indexed" and answer with a
   * pointless full scan on every call.
   *
   * Unreadable status resolves to `true` (assume not indexed): of the two ways
   * to be wrong, indexing unnecessarily is the recoverable one.
   */
  async projectNeverIndexed(projectId: string): Promise<boolean> {
    if (isHubOnly()) return false;
    try {
      const res = await apiClient.get<{ never_indexed?: boolean }>(
        `${FS_RECORDS_BASE}/index-status?${projectScopeQs(projectId)}`,
      );
      return res?.never_indexed !== false;
    } catch {
      return true;
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
      const qs = new URLSearchParams({
        user: 'false',
        projects: projectId,
        force: 'true',
      });
      await apiClient.post(`${FS_RECORDS_BASE}/index?${qs.toString()}`);
      void dataManager.refreshScanInfo();
    } finally {
      if (this.currentActivity === 'index') this._setActivity(null);
    }
  }

  /**
   * Fast, session-scoped re-index for one project — backs the "Recent Sessions"
   * refresh button. Indexes Claude sessions precisely (the project's
   * `~/.claude/projects/<encoded>` dir) plus Codex/Copilot sessions
   * (user-global storage, skip-fresh keeps it cheap). Emits the same WS
   * progress_report → footer-pill path as `fastScan`. Settle via `index_end`,
   * with the `finally` as a request-failed safety net.
   */
  async indexProjectSessions(projectId: string): Promise<void> {
    this._setActivity('index');
    try {
      const qs = new URLSearchParams({ project_id: projectId });
      await apiClient.post(`${FS_RECORDS_BASE}/index-sessions?${qs.toString()}`);
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
   * Resolve the target's project and set it as the active project: workdir
   * (longest-match on fs_storage_mount_path), else the entity's
   * `parent_type_id` chain, else CLEAR to null (the Global scope). Owning the
   * clear here keeps the "projectless ⇒ Global" policy in one place; every
   * loader's no-project branch is a single call.
   *
   * Persistence is opt-in via `entity.save`: a workdir-resolved id is written
   * back onto a savable entity; a parent-inherited project is NEVER persisted,
   * so a later re-mapping of the ancestor is followed live. Callers that must
   * not persist (e.g. load-lens with a recovered unindexed session) pass a
   * save-less `{ parent_type_id }`.
   */
  async resolveProjectContext(
    workdir: string | undefined,
    // `save` is `Promise<unknown>`, not `Promise<void>`: the real callers pass an
    // entity whose `APIEntity.save()` resolves to the entity, and a `Promise<T>`
    // is not assignable to a `Promise<void>` (the void-return special case does
    // not apply through a Promise). Nothing here reads the result.
    entity?: { project_id?: string | null; parent_type_id?: string | null; save?: () => Promise<unknown> },
  ): Promise<void> {
    const match = workdir ? await Project.getProjectByPath(workdir) : null;
    if (!match) {
      const inherited = await this.projectOfParentChain(entity?.parent_type_id ?? null);
      await dataContext.setContextEntityTypeId(
        ContextEntitiesEnum.CurrentProjectTypeId,
        inherited ? new TypeId(Project.type, inherited) : null,
      );
      return;
    }
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, match.typeId);
    if (entity?.save && !entity.project_id) {
      entity.project_id = match.id;
      await entity.save();
    }
  }

  /**
   * Nearest ancestor project along a `parent_type_id` chain (cycle-safe,
   * stops on a missing row). Read-only counterpart of the backend
   * `Entity.effective_project_id` — the two must agree so the active scope a
   * loader resolves never diverges from the project the Tab mint stamps.
   */
  private async projectOfParentChain(parentRef: string | null): Promise<string | null> {
    const seen = new Set<string>();
    let ref = parentRef;
    while (ref && !seen.has(ref)) {
      seen.add(ref);
      let ent: { project_id?: string | null; parent_type_id?: string | null } | null = null;
      try {
        ent = await dataManager.getByTypeId(new TypeId(ref));
      } catch {
        return null;
      }
      if (!ent) return null;
      if (ent.project_id) return ent.project_id;
      ref = ent.parent_type_id ?? null;
    }
    return null;
  }

  // ---- System diagnoses (flowpad_diagnosis) --------------------------------

  /** List all recorded diagnoses, newest first when a created timestamp exists. */
  async getDiagnoses(): Promise<FlowpadDiagnosis[]> {
    const rows = await FlowpadDiagnosis.query<FlowpadDiagnosis>(
      new QueryRequest({ type: FlowpadDiagnosis.type, scope: [] }),
    );
    return rows.sort(
      (a, b) =>
        new Date(b.created_date ?? 0).getTime() - new Date(a.created_date ?? 0).getTime(),
    );
  }

  /** Delete a diagnosis by id. */
  async deleteDiagnosis(id: string): Promise<void> {
    await dataManager.delete(new TypeId(FlowpadDiagnosis.type, id));
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
