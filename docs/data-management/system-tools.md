---
id: 47a5f579-4616-50fc-a542-1680b4d0a2ee
---

# System Tools Service (Frontend)

`SystemToolsService` is the TypeScript SDK service for system-level data
management operations: backup, archive, restore, clear, scan, and index. It is
a reactive `EventEmitter` exposed to React through `useSystemTools()`.

**Singleton:** `systemTools` in `ts_sdk/src/services/system-tools-service.ts`,
pre-configured for the `@local` compute node.

---

## Activity Model

Only one system activity runs at a time. `currentActivity === null` means idle.

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
| `progressTable` | `IndexProgressTable \| null` | Latest scan/index table snapshot |
| `scanInfo` | `ScanInfo \| null` | Mirrors `dataManager.scanInfo`, auto-updated |

The service emits `'state_changed'` whenever any of these fields change.

---

## `progress_report` WebSocket Events

During scan and index operations the backend broadcasts `progress_report`
FlowData events over WebSocket. Each event carries a complete
`IndexProgressTable` snapshot. Consumers replace their local table with the
latest event; they do not merge sub-events.

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

Each scan/index operation acquires a slot in `_COMPUTE_ACTIVITIES`, keyed by
`"{entity_typeid}:{job_name}"`. A duplicate request while the job is running
returns **409 Conflict**. Slots are released in `finally` blocks and also
auto-expire after `timeout_seconds`.

**Source:** `flow_sdk/builtin/faas/in_process_activity.py`.

---

## Reactive Hook: `useSystemTools()`

**File:** `ui/src/hooks/use-system-tools.ts`

```ts
const {
  currentActivity,  // SystemActivity | null
  progressTable,    // IndexProgressTable | null
  scanInfo,         // ScanInfo | null
  busy,             // currentActivity !== null
  clearIndex, clearAllData,
  backup, archive, restore,
  indexType, indexTypes,
  resetAndRescan,
  fastScan,
} = useSystemTools();
```

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

Indexes the supplied types sequentially. Each per-type backend request emits
its own `IndexProgressTable` snapshots; the optional callback is still invoked
for callers that need explicit per-type sequencing.

### `resetAndRescan()`

Compound operation used by the search refresh UI:

```
1. archive
2. clear
3. scan   - aggregate GET /fs-records/scan, table events drive progress
4. index  - aggregate POST /fs-records/index, table events drive progress
```

The `currentActivity` cycles `'archive' -> 'clear' -> 'scan' -> 'index' -> null`.

---

## Shared UI Components

`ActivityProgressBar` and `ActivityProgressModal` in
`ui/src/components/search-index/ActivityProgressModal.tsx` render the compact
aggregate progress and the per-type row table.

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

| Component | Uses hook for |
|-----------|---------------|
| `database-section.tsx` | `currentActivity` for clear/archive state |
| `danger-zone.tsx` | same |
| `FsRecordsScannerViewer.tsx` | scanner/index bars and modals |
| `IndexNowModal.tsx` | `indexTypes` and `progressTable` rows |
| `IndexRecommendedBanner.tsx` | stale-index refresh and row status |
| `SearchView.tsx` | `resetAndRescan`, compact strip, modal |

**Key source files:**
- `ts_sdk/src/services/system-tools-service.ts`
- `ui/src/hooks/use-system-tools.ts`
- `ui/src/components/search-index/ActivityProgressModal.tsx`
