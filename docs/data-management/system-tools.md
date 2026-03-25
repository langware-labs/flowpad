# System Tools Service (Frontend)

`SystemToolsService` is the TypeScript SDK service for system-level data management operations (backup, archive, restore, clear, scan, index). It is a reactive `EventEmitter` that tracks the currently running activity and exposes its state to React components via the `useSystemTools()` hook.

**Singleton:** `systemTools` in `ts_sdk/src/services/system-tools-service.ts`, pre-configured for `@local` compute node.

---

## Activity Model

Only one activity runs at a time. `currentActivity === null` means idle.

```ts
export type SystemActivity = 'clear' | 'archive' | 'load_from_archive' | 'scan' | 'index';

export interface ActivityProgress {
  // Orchestration-level (set by resetAndRescan phases, seeded from type list)
  total: number;
  done: string[];          // completed type names (advanced by WS sub-activity events)
  current: string | null;  // type currently processing (set by WS sub-activity event)
  pending: string[];       // types not yet started
  counts?: Record<string, number>; // record counts per type (legacy / indexTypes path)

  // Sub-activity level — populated by progress_report WS events (sub_activity_name set)
  recordsDone?: number;    // records processed within the current type
  recordsTotal?: number;   // total records in the current type
  recordsSkipped?: number; // records skipped (index only)
  recordsErrors?: number;  // records with errors

  // Job level — populated by progress_report WS events (sub_activity_name=null)
  jobDone?: number;        // types completed (from backend counter)
  jobTotal?: number;       // total types (from backend counter)
  jobText?: string;        // optional status text
}
```

### `progress_report` WebSocket Events

During aggregate scan and index operations the backend broadcasts `progress_report` FlowData events over WebSocket. Two event shapes are emitted, interleaved per type:

```json
// Sub-activity event (sub_activity_name set) — per-record progress within a type
{
  "element_type": "progress_report",
  "attributes": {
    "job_name": "scan",
    "sub_activity_name": "skill",
    "done": 25, "skipped": 0, "errors": 0, "total": 500, "text": null
  }
}

// Job-level event (sub_activity_name=null) — type completed
{
  "element_type": "progress_report",
  "attributes": {
    "job_name": "scan",
    "sub_activity_name": null,
    "done": 3, "skipped": 0, "errors": 0, "total": 12, "text": null
  }
}
```

The `SystemToolsService` WS listener filters these by `job_name === currentActivity` and populates `activityProgress` fields accordingly. Sub-activity events also advance `activityProgress.current` and `done[]`.

### Conflict detection (`InProcessActivity`)

Each scan/index operation acquires a slot in `_COMPUTE_ACTIVITIES` (module-level dict keyed by `"{entity_typeid}:{job_name}"`). A duplicate request while the job is running returns **409 Conflict**. The slot is released in a `finally` block. Slots auto-expire after `timeout_seconds` (default 600s for aggregate, 60s for per-type).

**Source:** `flow_sdk/builtin/faas/in_process_activity.py` — `InProcessActivity` dataclass.

State fields on the service:

| Field | Type | Description |
|-------|------|-------------|
| `currentActivity` | `SystemActivity \| null` | Currently running activity, null when idle |
| `activityProgress` | `ActivityProgress \| null` | Per-step progress (null for single-step activities) |
| `scanInfo` | `ScanInfo \| null` | Mirrors `dataManager.scanInfo`, auto-updated |

The service emits `'state_changed'` whenever any of these fields change.

---

## Reactive Hook: `useSystemTools()`

**File:** `ui/src/hooks/use-system-tools.ts`

Uses `useSyncExternalStore` to subscribe to the singleton service. All components calling this hook share the same state — if one component triggers a backup, all components with this hook see `currentActivity === 'archive'` immediately.

```ts
const {
  currentActivity,   // SystemActivity | null
  activityProgress,  // ActivityProgress | null
  scanInfo,          // ScanInfo | null
  busy,              // boolean — currentActivity !== null
  // Actions (bound to singleton):
  clearIndex, clearAllData,
  backup, archive, restore,
  indexType, indexTypes,
  resetAndRescan,
  getPaths, getStats, setDbPath,
  openBackupFolder, openDbFolder, openLogsFolder,
} = useSystemTools();
```

**Pattern for derived state:**
```ts
const isClearing = currentActivity === 'clear';
const isBacking  = currentActivity === 'archive';
const indexingAll = currentActivity === 'index';
```

---

## Methods

### Single-step operations (no sub-progress)

| Method | Sets `currentActivity` |
|--------|------------------------|
| `backup()` | `'archive'` |
| `archive()` | `'archive'` |
| `restore(backupPath)` | `'load_from_archive'` |
| `clearIndex(types?)` | `'clear'` |
| `clearAllData()` | `'clear'` |

Each resets `currentActivity` to `null` in a `finally` block.

### Multi-step operations (with per-step progress)

#### `indexTypes(types, onProgress?)`

Sequences through each type, emitting `'index'` activity updates per step. `activityProgress` is updated with `done`/`current`/`pending` after each type. Resets to `null` when complete.

```ts
await systemTools.indexTypes(types); // hook picks up progress automatically
// or with legacy callback:
await systemTools.indexTypes(types, (done, current, pending) => { ... });
```

### `resetAndRescan()`

Compound five-phase operation visible in `SearchView`'s refresh button:

```
1. archive    — DB + records snapshot
2. clear      — wipe FTS + entity index
3. (fetch)    — get registered type list to seed activityProgress.pending
4. scan       — aggregate scan: single GET /fs-records/scan (WS events drive progress)
5. index      — aggregate index: single POST /fs-records/index (WS events drive progress)
```

The `currentActivity` cycles `'archive' → 'clear' → 'scan' → 'index' → null`. Unlike the old per-type loop, scan and index phases now issue **single aggregate HTTP requests**. `activityProgress.current`, `done[]`, `recordsDone/Total`, and `jobDone/Total` are all updated reactively from `progress_report` WS events — the frontend no longer drives per-type sequencing.

---

## Shared UI Components

### `ActivityProgressModal` + `ActivityProgressBar`

**File:** `ui/src/components/search-index/ActivityProgressModal.tsx`

Reusable progress display extracted from `FsRecordsScannerViewer`.

```tsx
// Bar (inline, clickable — opens modal)
<ActivityProgressBar progress={activityProgress} onClick={() => setModalOpen(true)} />

// Detailed modal
<ActivityProgressModal
  open={modalOpen}
  onOpenChange={setModalOpen}
  progress={activityProgress}
  title="Indexing Progress"
/>
```

---

## Search Refresh Button

The `SearchView` (`ui/src/pages/search-view/SearchView.tsx`) exposes a `RotateCcw` button next to the search bar that calls `resetAndRescan()`. While running:

1. The button spins and is disabled
2. A compact activity strip appears below the search bar showing the current activity label + mini progress bar
3. Clicking the strip opens `ActivityProgressModal` with full done/current/pending detail

---

## Callers

| Component | Uses hook for |
|-----------|---------------|
| `database-section.tsx` | `isClearing`, `isBackingUp` (via `currentActivity`) |
| `danger-zone.tsx` | same |
| `FsRecordsScannerViewer.tsx` | `indexingAll`, `clearing`, `activityProgress` for index bar + modal |
| `IndexNowModal.tsx` | `indexTypes` + `activityProgress` for per-type list |
| `IndexRecommendedBanner.tsx` | `indexTypes` + `activityProgress` for per-type inline progress |
| `SearchView.tsx` | `resetAndRescan`, `currentActivity`, `activityProgress` for strip + modal |

**Key source files:**
- `ts_sdk/src/services/system-tools-service.ts` — service + singleton
- `ui/src/hooks/use-system-tools.ts` — React hook
- `ui/src/components/search-index/ActivityProgressModal.tsx` — shared bar + modal
