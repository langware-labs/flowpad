---
id: 2fbab7d7-2dc8-591e-946e-68c58e96f225
---

# TraceGutter - FlowData Trace Events in the Terminal Left Gutter

## Overview

TraceGutter is the left gutter next to the interactive terminal. It renders
agent trace events against terminal rows.

The terminal has two parallel channels:

1. **PTY I/O channel** - `Shell` / `PtyConnection` delivers terminal bytes to xterm and accepts user keystrokes. This is the interactive terminal itself.
2. **FlowData trace channel** - `AgenticProcess.flowDataStream` delivers history, live worker stream events, and hook/sniffer events for trace UI.

The trace gutter does not parse prompt text out of PTY bytes. PTY output is only
used for row coordinates through `PtySyncSession`.

## Current Data Model

### FlowData Sources

`AgenticProcess.flowDataStream` is the source of truth for the left gutter.

| Source | How it enters the stream | Notes |
|--------|--------------------------|-------|
| History | `process.loadHistory()` calls the backend `get-history` action. The active driver reads the JSONL transcript and converts entries to `FlowData`. | Marked `FlowDataSource.History`. |
| Live stream | Print/headless worker output and SDK streaming ingest append `FlowData` as the process runs. | Marked as live stream source. |
| Sniffer/hooks | `listen.py` converts hook payloads to canonical `FlowData` and routes a copy to the matching `AgenticProcess`. | Used for hook-level telemetry such as `UserPromptSubmit`, tool hooks, notifications. |
| Optimistic user echo | Some API/execute paths append user-message `FlowData` before backend confirmation. | This is not the interactive PTY keystroke path. |

### TraceEvent

**File:** `ui/src/types/trace-event.ts`

The renderer consumes vendor-neutral `TraceEvent`, mapped from `FlowData`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Derived from `FlowData.index` and timestamp. |
| `timestamp` | `string` | `FlowData.timestamp`. |
| `source` | `FlowDataSource` | History, stream, sniffer, etc. |
| `session_id` | `string` | Current `AgenticProcess.session_id`. |
| `event_type` | `string` | `attributes.subtype`, then `attributes["tool-name"]`, then `elementType`. |
| `element_type` | `string?` | Original `FlowData.elementType`. |
| `tool_name` | `string?` | `attributes["tool-name"]`. |
| `raw` | `Record<string, any>` | Object data, or `{ value }` for scalar data. |
| `attributes` | `Record<string, string>?` | Original FlowData attributes. |

There is no separate `ClaudeTraceEvent` or `session-transcript` path in the
current gutter implementation.

## Frontend Flow

### `useAgenticProcessStream`

**File:** `ui/src/hooks/use-agentic-process-stream.ts`

Subscribes to `process.flowDataStream` with `useSyncExternalStore`. The stable
snapshot is load-bearing: it prevents array-reference churn from causing render
loops in terminal tooltip/layout code.

### `useFlowDataTrace`

**File:** `ui/src/hooks/use-flow-data-trace.ts`

1. Calls `process.loadHistory()` once per process id.
2. Subscribes to the same `process.flowDataStream` used for live events.
3. Maps every `FlowData` item through `mapFlowDataToTraceEvent()`.
4. Sorts by timestamp.
5. Counts history vs live events from `FlowData.source`.

### `useTraceGutter`

**File:** `ui/src/components/terminal/interactive-terminal/use-trace-gutter.ts`

Signature:

```ts
function useTraceGutter(
  process: AgenticProcess | null,
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
  allEvents: TraceEvent[];
}
```

Behavior:

1. Reads `TraceEvent[]` from `useFlowDataTrace(process)`.
2. Waits for terminal readiness and replay completion.
3. Deduplicates by event id.
4. Buckets each event timestamp through `ptySyncSession.bucketTimestamp(ts)`.
5. Returns `TraceGutterEntry[]` for rendering.

Bucketing is pure inside `useMemo`; the hook does not keep an anchor map in
React state.

## Row Mapping

`PtySyncSession` maintains terminal row coordinates from the PTY channel:

- `processChunk()` records output chunks and terminal row progression.
- `buildSegmentsFromAnchors()` can rebuild time-to-row segments from prompt anchors.
- `bucketTimestamp(ts)` maps a trace event timestamp to an absolute xterm row.

The important split:

- PTY bytes establish terminal coordinates.
- FlowData events establish trace data.
- TraceGutter combines them only at render time by timestamp bucketing.

## Backend Flow

### History

`AgenticProcess.loadHistory()` calls the backend `get-history` action.

Backend path:

1. `AgenticProcess.get_history_action()`
2. active driver `load_history(process)`
3. driver reads worker transcript JSONL
4. transcript entries are converted to `FlowData`
5. frontend ingests those items into `process.flowDataStream`

### Hook/Sniffer Fan-Out

`flow_sdk/app/actions/listen.py` handles hook webhooks.

For hook events:

1. Convert hook payload to canonical `FlowData`.
2. Broadcast to the global `@sniffer` `AgentHook` for the global sniffer panel.
3. Route a copy to the source `AgenticProcess` when `FLOWPAD_EXECUTION_SCOPE` or session metadata identifies it.

The terminal TraceGutter reads the per-process copy, not the global sniffer
panel state.

## Prompt Index

Prompts are a special case. The prompt index is not sourced from the trace
gutter event list.

Canonical prompt text comes from the transcript-specific action:

```text
POST /api/v1/graph/agentic_process/{id}/transcript/prompts
```

Frontend path:

1. `InteractiveTerminal` calls `process.getPrompts()`.
2. `AgenticProcess.getPrompts()` creates `ActionInfo('transcript', AgenticProcess.type, id, 'POST')`.
3. It sets `actionInfo.subpath = 'prompts'`.
4. The response is hydrated into `UserMessageEntry[]` through the transcript analyzer.

Backend path:

1. `AgenticProcess.transcript_action()` receives action `transcript` with sub-path `prompts`.
2. `_load_transcript()` resolves the active driver's JSONL transcript path.
3. `AgentTranscript(worker_type, path)` parses the transcript.
4. `_transcript_prompts()` returns `[e.to_dict() for e in transcript.prompts]`.

`AgentTranscript.prompts` filters out:

- sidechain user entries
- empty or whitespace-only text
- Claude Code synthetic interrupt markers such as `[Request interrupted by user for tool use]`

Prompt annotations are auxiliary row anchors:

1. `listen.py` sees `UserPromptSubmit`.
2. It creates an `Annotation` with `labels=["prompt:"]`, `session_id`, and truncated prompt content.
3. `useAnnotationGutter()` queries annotations and resolves prompt rows by searching xterm text.
4. `InteractiveTerminal` matches transcript prompts to nearby prompt annotations within 1000 ms.
5. If an annotation exists, the prompt can scroll to its terminal row. If it is missing, the prompt still renders from the transcript endpoint.

## TraceGutter Rendering

**File:** `ui/src/components/terminal/interactive-terminal/TraceGutter.tsx`

Props:

| Prop | Type | Description |
|------|------|-------------|
| `entries` | `TraceGutterEntry[]` | FlowData trace events with resolved rows. |
| `cellHeight` | `number` | Terminal cell height in pixels. |
| `viewportY` | `number` | Current viewport scroll offset. |
| `rows` | `number` | Visible terminal rows. |
| `totalTraceEvents` | `number` | Total event count. |
| `historicalCount` | `number` | Count with `FlowDataSource.History`. |
| `liveCount` | `number` | Count from non-history sources. |

Collapsed mode renders row dots for visible entries. Expanded mode lays out an
overlay list with collision avoidance for events that bucket to the same row.

## File Map

| File | Purpose |
|------|---------|
| `ui/src/components/terminal/interactive-terminal/TraceGutter.tsx` | Left gutter component. |
| `ui/src/components/terminal/interactive-terminal/use-trace-gutter.ts` | Buckets per-process FlowData trace events to terminal rows. |
| `ui/src/hooks/use-flow-data-trace.ts` | Loads history and maps `AgenticProcess.flowDataStream` to `TraceEvent[]`. |
| `ui/src/hooks/use-agentic-process-stream.ts` | Stable `useSyncExternalStore` subscription to `flowDataStream`. |
| `ui/src/types/trace-event.ts` | Vendor-neutral `TraceEvent` and FlowData mapper. |
| `ts_sdk/src/process/agentic-process.ts` | `loadHistory()`, `getPrompts()`, and `getPlan()` frontend actions. |
| `flow_sdk/builtin/agentic_process/agentic_process.py` | Backend `get-history` and `transcript/{plan,prompts}` actions. |
| `flow_sdk/transcript_analyzer/transcript.py` | `AgentTranscript.prompts` filtering logic. |
| `flow_sdk/app/actions/listen.py` | Hook conversion, sniffer broadcast, per-process FlowData routing, prompt annotations. |
