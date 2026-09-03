---
id: 47a5f579-4616-50fc-a542-1680b4d0a2ee
---

# System Tools Service (Frontend)

`SystemToolsService` is the TypeScript SDK service for system-level data
management operations: backup, archive, restore, clear, scan, and index. It is
a reactive `EventEmitter` exposed to React through `useSystemTools()`.

**Singleton:** `systemTools` in `ts_sdk/src/services/system-tools-service.ts`,
constructed as `new SystemToolsService({ type: 'compute_node', id: '@local' })`.
Every call goes through `apiClient` with a path, never a URL. Two backend
actions on that compute node are used:

| Base path | Backend | Used for |
|-----------|---------|----------|
| `/graph/compute_node/@local/desktop-db/<sub>` | `flow_sdk/app/actions/desktop_db.py` (`@action.all("desktop-db")`) | `paths`, `stats`, `db-settings` (GET); `backup`, `archive`, `restore`, `clear`, `clear-index`, `db-settings`, `open-backup` / `open-db` / `open-logs` folders (POST) |
| `/graph/compute_node/@local/fs-records/<sub>` | `FsRecordsActionsMixin` (see `compute-node-fs-records.md`) | `scan` (GET), `index` (POST, also with `?type=`, `?path=`, `?projects=`, `?force=`), `index-sessions` (POST), `index-status` (GET), `activity-status` (GET), `{type}/discover?path=` (POST) |

On construction the service immediately calls `refreshActivityStatus()` so an
in-flight scan/index is picked up again after a page reload, and subscribes to
`dataManager.onScanInfoChange` to mirror `scanInfo`.

---

## Activity Model

`SystemToolsService` exposes one foreground `currentActivity` at a time;
`currentActivity === null` means the service is idle. The backend's exclusion
boundary is narrower: `_COMPUTE_ACTIVITIES` is keyed by compute node and job
name, so duplicate scans conflict with scans and duplicate indexes conflict
with indexes, but a scan and an index can overlap.

```ts
export type SystemActivity = 'clear' | 'archive' | 'load_from_archive' | 'scan' | 'index';

export interface TypeProgressRow {
  type_name: string;
  done: number;
  total: number;
  errors: number;
  skipped: number;
}

export interface IndexProgressTable {
  job_name: SystemActivity;
  rows: TypeProgressRow[];
  current: string | null;
  done: number;
  total: number;
  text: string | null;
  ts: string;
}
```

State fields on the service:

| Field | Type | Description |
|-------|------|-------------|
| `currentActivity` | `SystemActivity \| null` | Currently running activity, null when idle |
| `progressTable` | `IndexProgressTable \| null` | Latest scan/index table snapshot. Deliberately **kept** when `currentActivity` drops to null, so the inter-phase boundary of `resetAndRescan` does not blank the strip; consumers gate on `currentActivity && progressTable`. |
| `scanInfo` | `ScanInfo \| null` | Mirrors `dataManager.scanInfo`, auto-updated |
| `lastScanResult` | `LastScanResult \| null` | The aggregate scan result captured by the last `resetAndRescan` |

The service emits `'state_changed'` whenever any of these fields change.

---

## `progress_report` WebSocket Events

During scan and index operations the backend broadcasts `progress_report`
FlowData events over WebSocket to every active connection. Each event carries a
complete `IndexProgressTable` snapshot. The envelope has no request/run id, so a
connection can observe snapshots from a different concurrent activity (for
example, the detached startup system-content index while a manual scan runs).
Consumers must not assume every event received during an HTTP request belongs
to that request.

`SystemToolsService` sets its foreground phase before an operation and ignores
events whose `job_name` differs while that phase is active. Accepted snapshots
replace the local table wholesale; they are not merged.

The subscription is `connectionManager.on('on_flow_data', ...)` filtered on
`element_type === 'progress_report'`. Around it sit three timers:

| Mechanism | Value | Purpose |
|-----------|-------|---------|
| Emit throttle | 16 ms | Batches rapid WS snapshots into one `'state_changed'` per frame. |
| Completion timer | 2 s after a `text: "complete"` snapshot | Drops `currentActivity` to null and refreshes `scanInfo` — unless a later phase's `_setActivity(...)` cancelled it first, which is how `resetAndRescan`'s archive→clear→scan→index hand-off avoids blinking to idle between phases. |
| Idle watchdog | 5 s without a WS event while an activity is set | Calls `refreshActivityStatus()` (`GET /fs-records/activity-status`) to settle; re-seeds the table and phase when the backend says the job is still running, else clears. This is the safety net for a dropped final completion event. |

`refreshActivityStatus()` treats a `null` payload from the backend as "idle" and
a payload as "running with this table"; it is also what the constructor calls
on page load.

```json
{
  "element_type": "progress_report",
  "attributes": {
    "job_name": "index",
    "rows": [
      { "type_name": "skill", "done": 25, "total": 100, "errors": 0, "skipped": 10 },
      { "type_name": "workflow", "done": 3, "total": 12, "errors": 0, "skipped": 0 }
    ],
    "current": "skill",
    "done": 28,
    "total": 112,
    "text": null,
    "ts": "2026-05-07T12:00:00+00:00"
  }
}
```

Progress is emitted only as table snapshots, with aggregate totals and per-type
rows in the same payload.

For `index`, totals are known before indexing starts because the backend first
performs an internal scan. The first table contains all known type rows with
`done=0` and populated `total`.

For `scan`, totals are unknown while discovery is running. The table-level
`total` is `0`, and rows are added as record types are discovered. The UI shows
count-only scan progress instead of a percentage.

The terminal event has `text: "complete"` and `current: null`.

---

## Conflict Detection

Each scan/index operation acquires a slot in the module-level
`_COMPUTE_ACTIVITIES` registry, keyed by `"{entity_typeid}:{job_name}"`.
`ComputeNode._start_activity()` raises `RuntimeError("Job '<name>' already
running")` when a live slot exists, which the `scan` and `clear` handlers
translate into a **409 Conflict** response. `POST /fs-records/index` instead
QUEUES for the slot and then runs its own pass — the backend takes `index` at
boot for the system-asset pass while already reporting itself healthy, so a
refusal there was a collision the client could not see. The footer therefore
shows a queued index as pending rather than surfacing an error. Slots are released by
`ComputeNode._complete_activity()` in `finally` blocks and also auto-expire
once `started_at` is older than `timeout_seconds` (`InProcessActivity.is_timed_out`),
or once the latest table reports completion (`is_complete` — true only on the
`text: "complete"` terminal snapshot, never inferred from `done >= total`).
`timeout_seconds` is 600 for `scan` and `index`, 300 for the `index` slot taken by
`POST /fs-records/index-sessions`, and 120 for `clear`. The sibling
`GET /asset-usage` action also takes the `scan` slot.

**Sources:** the registry, `_start_activity`/`_complete_activity`, and the
`"{entity_typeid}:{job_name}"` key live in
`flow_sdk/builtin/faas/compute_node.py`; the `InProcessActivity` dataclass
(`job_name`, `entity_id`, `started_at`, `timeout_seconds`, `is_timed_out`,
`is_complete`) lives in `flow_sdk/builtin/faas/in_process_activity.py`. The
`finally`-block releases and 409 responses are in
`flow_sdk/builtin/faas/fs_records_actions.py`.

---

## Reactive Hook: `useSystemTools()`

**File:** `ui/src/hooks/use-system-tools.ts`

```ts
const {
  // reactive snapshot fields
  currentActivity,  // SystemActivity | null
  progressTable,    // IndexProgressTable | null
  scanInfo,         // ScanInfo | null
  lastScanResult,   // LastScanResult | null
  busy,             // currentActivity !== null
  // bound methods
  clearIndex, clearAllData,
  backup, archive, restore,
  indexType, indexTypes, indexProjectSessions,
  resetAndRescan,
  getPaths, getStats, getDbSettings, setDbPath,
  openBackupFolder, openDbFolder, openLogsFolder,
} = useSystemTools();
```

The hook is a `useSyncExternalStore` over the singleton's `'state_changed'`
event with a shallow-equal snapshot, so a component re-renders only when one of
the five snapshot fields actually changes.

> The hook does **not** expose `fastScan` / `fastScanProject` /
> `hardRefreshProject` / `projectNeverIndexed` / `discoverByPath` /
> `resolveProjectContext` / `refreshActivityStatus` / `getScanInfo`. Those live
> only on the `systemTools` singleton — call them as `systemTools.fastScan()`
> etc. The hook surfaces the snapshot fields plus the bound methods listed above.

All components using the hook see the same singleton state.

---

## Methods

### Single-step operations

| Method | Sets `currentActivity` |
|--------|------------------------|
| `backup()` | `'archive'` |
| `archive()` | `'archive'` |
| `restore(backupPath)` | `'load_from_archive'` |
| `clearIndex(types?)` | `'clear'` |
| `clearAllData()` | `'clear'` |

Each resets `currentActivity` to `null` in a `finally` block.

### `indexTypes(types, onProgress?)`

Indexes the supplied types sequentially (`POST /fs-records/index?type=X` per
type). Each per-type backend request emits its own `IndexProgressTable`
snapshots; the optional callback is still invoked for callers that need
explicit per-type sequencing.

### Singleton-only index verbs (all set `'index'`)

| Method | Backend call |
|--------|--------------|
| `fastScan()` | `POST /fs-records/index` — incremental, no archive/clear |
| `fastScanProject(projectId)` / `hardRefreshProject(projectId)` | `POST /fs-records/index?projects=…` (hard refresh adds `force=true`) |
| `indexProjectSessions(projectId)` | `POST /fs-records/index-sessions?project_id=…` |
| `discoverByPath(typeName, path)` | `POST /fs-records/{type}/discover?path=…` — find-or-recover a single record; sets no activity |

Each resets `currentActivity` to `null` in `finally` only if it is still
`'index'`, so a phase that took over in between is not clobbered.

### `resetAndRescan()`

Compound operation used by the search refresh UI:

```
1. archive     - POST desktop-db/archive
2. clear       - POST desktop-db/clear-index
3. scan        - aggregate GET /fs-records/scan, table events drive progress
4. index       - aggregate POST /fs-records/index, table events drive progress
```

The `currentActivity` cycles `'archive' -> 'clear' -> 'scan' -> 'index' -> null`,
and the scan's HTTP result is kept as `lastScanResult`.

---

## Shared UI Components

`ActivityProgressBar`, `MiniProgressBar` and `ActivityProgressModal` in
`ui/src/components/search-index/ActivityProgressModal.tsx` render the compact
aggregate progress and the per-type row table. They are mounted once each:
`ActivityIndicator.tsx` (the footer strip, uses `ActivityProgressBar` /
`MiniProgressBar`) and `ActivityProgressModalRoot.tsx` (the modal, mounted from
`App.tsx`). Both read `currentActivity` / `progressTable` from `useSystemTools()`.

```tsx
<ActivityProgressBar table={progressTable} onClick={() => setModalOpen(true)} />

<ActivityProgressModal
  open={modalOpen}
  onOpenChange={setModalOpen}
  table={progressTable}
  title="Indexing Progress"
/>
```

---

## Callers

Every `useSystemTools()` caller in `ui/src` (there is no `danger-zone.tsx`):

| Component | Uses hook for |
|-----------|---------------|
| `account/database-section.tsx` | `currentActivity` for clear/archive/backup state, db paths and settings |
| `search-index/ActivityIndicator.tsx` | the footer progress strip |
| `search-index/ActivityProgressModalRoot.tsx` | the per-type progress modal |
| `search-index/IndexerStatusPill.tsx` | `currentActivity`, `progressTable` |
| `search-index/IndexNowModal.tsx` | `indexTypes` and `progressTable` rows |
| `search-index/IndexRecommendedBanner.tsx` | stale-index refresh and row status |
| `lens-viewer/FsRecordsScannerViewer.tsx` | scanner/index bars and modals |
| `pages/search-view/SearchView.tsx` | `resetAndRescan`, compact strip, modal |
| `assets/AssetsPage.tsx` | `busy`, `resetAndRescan` |
| `assets/useAssetsModel.tsx` | `indexType` |
| `collaboration/ProjectViewHeader.tsx` | `busy` |
| `terminal/HistoryModal.tsx` | `indexProjectSessions` |
| `pages/home-landing/HomeLanding.tsx` | `lastScanResult` |

**Key source files:**
- `ts_sdk/src/services/system-tools-service.ts`
- `ui/src/hooks/use-system-tools.ts`
- `ui/src/components/search-index/ActivityProgressModal.tsx`
