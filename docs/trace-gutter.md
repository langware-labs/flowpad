# TraceGutter — Hook Events & Historical Transcript in the Terminal Left Gutter

## Overview

TraceGutter is the left gutter alongside the terminal that shows hook events and historical transcript entries. It was renamed from SnifferGutter.

Two data sources are merged into a unified timeline:

1. **Live sniffer events** — hook events captured in real time, anchored to a terminal row via `absRow`.
2. **Historical transcript entries** — past session entries fetched from the backend, with `absRow = null` (no cursor position available).

Both are mapped to the unified `ClaudeTraceEvent` type before rendering.

## ClaudeTraceEvent (unified type)

**File:** `ui/src/types/trace-event.ts`

### TraceEventSource

```ts
type TraceEventSource = 'transcript' | 'sniffer';
```

### ClaudeTraceEvent interface

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier |
| `idx` | `number?` | Sniffer sequence index (undefined for transcript events) |
| `timestamp` | `string` | ISO timestamp |
| `source` | `TraceEventSource` | `'sniffer'` or `'transcript'` |
| `session_id` | `string` | Claude session UUID |
| `event_type` | `string` | Event name (e.g. `PreToolUse`, `UserMessage`, `System:init`) |
| `summary` | `string?` | Short text summary |
| `tool_name` | `string?` | Tool name for tool_use events |
| `tool_input` | `Record<string, any>?` | Tool input for tool_use events |
| `absRow` | `number?` | Absolute terminal row (only set during rendering, not in the type's data flow) |
| `raw` | `Record<string, any>` | Raw event data (parsed JSON for sniffer, entry object for transcript) |
| `transcript_path` | `string?` | Transcript file path (sniffer only) |
| `webhook_type` | `string?` | Webhook type (sniffer only) |
| `hook_data` | `Record<string, any>?` | Hook payload (sniffer only) |
| `layer` | `EventLayer?` | Event layer (sniffer only) |
| `warning` | `string?` | Warning message (sniffer only) |
| `error` | `string?` | Error message (sniffer only) |

### TranscriptEntryData interface

Represents a single entry from the backend transcript endpoint:

| Field | Type | Description |
|-------|------|-------------|
| `entry_type` | `string` | `user`, `assistant`, `system`, `progress`, etc. |
| `entry_uuid` | `string` | Unique entry ID |
| `timestamp` | `string` | ISO timestamp |
| `session_id` | `string` | Session UUID |
| `subtype` | `string?` | Subtype for system entries |
| `parent_uuid` | `string?` | Parent entry UUID |
| `is_sidechain` | `boolean?` | Whether this is a sidechain entry |
| `message` | `object?` | Contains `content`, `model`, `stop_reason`, `usage` |
| `data` | `Record<string, any>?` | Extra data |

### Mapper functions

#### `mapSnifferToTraceEvent(event: SnifferEvent): ClaudeTraceEvent`

- Parses `event.raw_line` via `JSON.parse`; falls back to `{ raw_line: event.raw_line }` on parse failure
- Maps all SnifferEvent fields directly, preserving `idx`, `layer`, `warning`, `error`

#### `mapTranscriptToTraceEvents(entry: TranscriptEntryData, sessionId: string): ClaudeTraceEvent[]`

Maps one transcript entry to one or more trace events:

| Entry type | Condition | Result |
|------------|-----------|--------|
| `assistant` | Has `tool_use` content blocks | One event per tool block. `event_type = block.name`. ID: `transcript-<entry_uuid>-tool-<i>` |
| `assistant` | Text only (no tool blocks) | Single event. `event_type = 'AssistantMessage'`. Summary extracted from text content (first 80 chars). |
| `user` | — | Single event. `event_type = 'UserMessage'`. Summary extracted from content. |
| `system` | — | Single event. `event_type = 'System:<subtype>'` or `'System:unknown'` if no subtype. |
| All others | — | Single event. `event_type = entry.entry_type` or `'Unknown'`. |

All transcript events have `source = 'transcript'`, `idx = undefined`, and `raw` set to the entry object itself.

## useTraceGutter hook

**File:** `ui/src/components/terminal/interactive-terminal/use-trace-gutter.ts`

### Signature

```ts
function useTraceGutter(
  workerSessionId: string | undefined | null,
  terminalReady: boolean,
  ptySyncSession: PtySyncSession,
  replayComplete: boolean,
  snapshotVersion: number,
): {
  entries: TraceGutterEntry[];
  totalTraceEvents: number;
  historicalCount: number;
  liveCount: number;
  sessionStartTime: string | null;
  allEvents: ClaudeTraceEvent[];
}
```

### TraceGutterEntry

```ts
interface TraceGutterEntry {
  absRow: number | null;
  event: ClaudeTraceEvent;
}
```

### Event anchoring via PtySegment bucketing

Both sniffer and transcript events are positioned by calling `ptySyncSession.bucketTimestamp(ts)`, which delegates to `bucketEventToAbsRow(ts, segments)` in `PtySegment.ts`. This finds the segment whose `[startTime, endTime]` contains `ts` and returns the corresponding absolute row. If no segment contains the timestamp, the last segment is used as a fallback.

**Sniffer events** — bucketed immediately as they arrive (no `replayComplete` requirement):

1. New events are detected via `processedSnifferRef` (Set of already-handled event IDs)
2. Each event's timestamp is bucketed via `ptySyncSession.bucketTimestamp(ts)` and stored in `anchorMapRef`
3. `anchorVersion` is bumped to trigger gutter re-render

**Transcript events** — bucketed after `replayComplete` is true, then re-bucketed whenever `snapshotVersion` changes (i.e. segments were rebuilt by `buildSegmentsFromAnchors`):

1. When `snapshotVersion` changes, all entries — **both transcript and sniffer** — are cleared from `anchorMapRef`. Sniffer IDs are also removed from `processedSnifferRef` so they are re-bucketed with the updated segments.
2. Events without an anchor are bucketed via `ptySyncSession.bucketTimestamp(ts)` and stored in `anchorMapRef`
3. `anchorVersion` is bumped if any bucket was added or if segments changed

### Merging

All events from `useClaudeSessionTrace` (which merges live sniffer events + historical transcript entries) are sorted by `event.timestamp` ascending. The final `entries` array maps each event to its `absRow` from `anchorMapRef`.

### Cleanup

When `workerSessionId` changes, `anchorMapRef`, `processedSnifferRef`, and `lastSnapshotVersionRef` are all cleared via an effect cleanup function.

## useSessionTranscript hook

**File:** `ui/src/hooks/use-session-transcript.ts`

### Signature

```ts
function useSessionTranscript(sessionId: string | null): {
  entries: TranscriptEntryData[];
  isLoading: boolean;
}
```

### Behavior

- Fetches `GET /api/v1/graph/compute_node/@local/session-transcript?session_id=<id>`
- Caches responses by `sessionId` in a `cacheRef` (never invalidated during component lifetime)
- Returns empty array when `sessionId` is null
- On cache hit, returns cached data immediately without a network request
- On fetch failure, logs a warning and returns the previous entries

## Backend endpoint

**Endpoint:** `GET /api/v1/graph/compute_node/@local/session-transcript`

**Query parameters:**
- `session_id` (required) — Claude session UUID
- `project` (optional) — Absolute project path for O(1) lookup

**Handler:** `flow_sdk/builtin/faas/compute_node.py` — `@action.get(action_name="session-transcript")`

**Logic:**
1. Reads `session_id` from query params; returns `ApiFailResponse` if missing
2. Looks up `ClaudeSessionRecord.discover_one(session_id, project=...)`
3. If not found, returns `ApiSuccessResponse(data=[])` (empty list, not a failure)
4. Returns `ApiSuccessResponse(data=record.to_transcript_dicts())`

**Data source:** `ClaudeSessionRecord.to_transcript_dicts(include_raw_json=False)` in `flow_sdk/fs_records/claude/claude_session.py`:
- Calls `self.filtered_entries` which excludes noisy entry types (`file-history-snapshot`, `progress`) via `EXCLUDED_ENTRY_TYPES`
- Serializes each entry via `.to_dict()` and strips the `raw_json` field to reduce response size

**Response format:** Standard `ApiResponse` with `data` as a flat list of entry dicts:
```json
{ "status": "SUCCESS", "data": [ { "entry_type": "user", "entry_uuid": "...", ... }, ... ] }
```

The frontend reads `json?.data ?? []` to extract the entries array.

## TraceGutter component

**File:** `ui/src/components/terminal/interactive-terminal/TraceGutter.tsx`

### Props

| Prop | Type | Description |
|------|------|-------------|
| `entries` | `TraceGutterEntry[]` | Merged trace entries from `useTraceGutter` |
| `cellHeight` | `number` | Terminal cell height in pixels |
| `viewportY` | `number` | Current viewport scroll offset |
| `rows` | `number` | Visible terminal rows |
| `totalTraceEvents` | `number` | Total event count |
| `historicalCount` | `number` | Count of historical transcript events |
| `liveCount` | `number` | Count of live sniffer events |

### Layout constants

- `GUTTER_WIDTH = 48` — constant width so the terminal never refits
- `PANEL_WIDTH = 220` — width of the expanded overlay panel

### Rendering modes

**Collapsed (default):** A dot column showing icons for row-anchored events. Only entries with `absRow` in the viewport range are shown as dots. Historical entries (`absRow = null`) are counted in the badge but NOT shown as dots.

- `EventCountBadge` at top: shows `liveCount` when no historical events, or `historicalCount + liveCount` format when historical > 0
- `GutterDot` per row group: shows an icon for the last event in that row, with a count badge if multiple events share the same row
- Tooltip on hover: single event shows `EventTooltipContent`; multiple events show a list with icons and one-liners

**Expanded:** Clicking the dot column toggles an absolutely-positioned overlay panel (does NOT affect flex layout, so xterm never refits).

- `computeLayout()` performs collision-avoidance: each entry gets a `displayRow >= naturalRow` and `displayRow >= previousDisplayRow + 1`
- Bracket connectors drawn between events that share the same `naturalRow`
- `ExpandedEventLine` shows icon + truncated event type (max 14 chars) + one-liner summary
- Tooltip on hover for full event details

## Bug fix: dedup in liveTraceEntries

The sniffer may return duplicate event objects (same `id`). The `liveTraceEntries` memo deduplicates by event id using `seen = new Set<string>()` to prevent duplicate gutter entries.

**Test:** `ui/tests/react/use-trace-gutter.test.ts` — `"duplicate sniffer event ids produce only one entry"`

## File map

| File | Purpose |
|------|---------|
| `ui/src/components/terminal/interactive-terminal/TraceGutter.tsx` | Left gutter component |
| `ui/src/components/terminal/interactive-terminal/use-trace-gutter.ts` | Hook — merges sniffer + transcript |
| `ui/src/types/trace-event.ts` | `ClaudeTraceEvent`, mapper functions |
| `ui/src/hooks/use-session-transcript.ts` | Transcript fetch + cache hook |
| `flow_sdk/builtin/faas/compute_node.py` | Backend `session-transcript` endpoint |
| `flow_sdk/fs_records/claude/claude_session.py` | `to_transcript_dicts()` method |
| `ui/tests/react/use-trace-gutter.test.ts` | Hook unit tests |
