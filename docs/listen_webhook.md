---
id: 43940640-93a4-5dbd-a6cc-d21ede048024
---

# Listen Webhook Pipeline

How hooks fire, get identified, flow through the listen endpoint, convert to FlowData, and render in the UI.

---

## 1. Listen Endpoint

The listen mechanism is a **webhook receive endpoint** at `POST /api/v1/webhook/listen`.

- **Route**: `server/routes/webhook.py` → delegates to `flow_sdk/app/actions/listen.py:listen_action()`
- **Always active** while the server is running — no explicit start/stop

### Request Flow

```
HTTP POST /api/v1/webhook/listen
  → listen_action(request)
  → Parse WebhookPayload { webhook_type, webhook_payload }
  → Route by type:
      agent_hook         → handle_agent_hook()          # Claude Code hook events
      hook_op            → handle_hook_op()             # Unified CRUD + event + invoke + log
      instruction_trace  → handle_instruction_trace()   # Legacy execution traces
```

### Webhook Types

| Type | Handler | Purpose |
|------|---------|---------|
| `agent_hook` | `handle_agent_hook()` | Claude Code hook events (tool use, prompt submit, etc.) |
| `hook_op` | `handle_hook_op()` | v2 envelope: CRUD, events, invokes, logs, relationships |
| `instruction_trace` | `handle_instruction_trace()` | Legacy instruction execution reports |

### Payload Models

Defined in `flow_sdk/core/flow/models/webhook_flow_data.py`:

- **`WebhookPayload`**: Outer envelope `{ webhook_type, webhook_payload }`
- **`AgentHookData`**: Claude Code hook events with `agent_hook_id`, `hook_data`, `hook_entry_id`, `hook_metadata`, `hook_file_path`
- **`FlowHookData`**: Instruction trace data

Defined in `flow_sdk/core/flow/models/hook_op.py`:

- **`HookOpPayload`**: v2 webhook envelope for CRUD + events + logs
- **`SyncOperation`**: CREATE, UPDATE, DELETE, EVENT, INVOKE, LOG
- **`RelationshipType`**: CHILD, PARENT, DEPENDS_ON, RELATED_TO

---

## 2. How a Specific Hook Is Identified

Hook identity is **embedded in the command string** in Claude Code's `settings.json`. This design was adopted because Claude Code's hook schema has `additionalProperties: false`, which strips unknown keys like `flow_metadata`.

### Command String Generation

File: `flow_sdk/builtin/claude_settings_sync.py:generate_hook_command()`

```python
def generate_hook_command(hook_id: str, name: str | None = None) -> str:
    cmd = f"flow hooks report --hook-entry-id={hook_id}"
    if name:
        cmd += f" --name={name}"
    return cmd
```

This produces commands like:
```bash
flow hooks report --hook-entry-id=agenthook:abc123 --name=flowpad_sniffer
```

### Identification Chain

```
1. Hook registered → command string generated with --hook-entry-id={ID} --name={NAME}
2. Written to settings.json under hooks.{EventName}[].hooks[].command
3. Claude Code fires hook → executes the command
4. CLI (flow hooks report) extracts ID and name from args
5. CLI reads hook event JSON from stdin
6. CLI builds payload: { agent_hook_id: ID, hook_metadata: {name, hook_entry_id} }
7. CLI POSTs to /api/v1/webhook/listen
8. handle_agent_hook() calls AgentHook.get_by_id(agent_hook_id)
9. Entity found → process triggers, emit FlowData
```

### Identifier Fields

| Field | Role | Example |
|-------|------|---------|
| `hook_entry_id` / `agent_hook_id` | **Primary** — AgentHook entity DB ID, embedded in command string | `"agenthook:abc123"` |
| `hook_name` | Symbolic name, also in command string | `"flowpad_sniffer"` |
| `hook_metadata` | JSON in payload carrying name + hook_entry_id | `{"name": "...", "hook_entry_id": "..."}` |
| `hook_file_path` | Path to settings.json for debugging | `"~/.claude/settings.json"` |
| `flow_metadata` (legacy) | **Deprecated** — Claude Code strips it; kept for reading old configs | — |

### Settings.json Format

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "flow hooks report --hook-entry-id=abc123 --name=flowpad_sniffer"
          }
        ]
      }
    ]
  }
}
```

---

## 3. Sniffer Hook

The sniffer is a **special catch-all AgentHook** entity that monitors all webhook events for frontend visibility.

### Properties

- `uname`: `"sniffer"`
- `hook_name`: `"flowpad_sniffer"`
- `is_sniffer` property: derived from `hook_name == "flowpad_sniffer"`
- `matcher`: `"*"` (catch-all)
- `hook_scope`: USER (`~/.claude/settings.json`)
- Passive monitor — does **not** execute triggers

### API Actions

File: `flow_sdk/app/actions/hooks_sniffer.py`

| Method | Action |
|--------|--------|
| `GET hooks-sniffer` | Check if sniffer hook is enabled |
| `POST hooks-sniffer` | Create/update sniffer AgentHook and sync to settings.json |
| `DELETE hooks-sniffer` | Disable and remove sniffer hook |

### Broadcasting

Every webhook arriving at `/listen` calls `_broadcast_to_sniffer()` in `listen.py`:

```python
async def _broadcast_to_sniffer(payload_data, webhook_type, ...):
    sniffer_hook = await AgentHook.get_by_uname("sniffer")
    if sniffer_hook:
        await sniffer_hook.emit_flow_data({
            "flow_value": payload_data,
            "attributes": {
                "element-type": "webhook",
                "data-type": "object",
                "webhook_type": webhook_type,
                "t": datetime.now(timezone.utc).isoformat(),
            },
        })
```

---

## 4. FlowData Conversion

### Python FlowData Model

File: `flow_sdk/core/flow/models/flow_data.py`

```python
class FlowData(BaseModel):
    flow_value: Any              # The actual data payload
    attributes: dict[str, str]   # Metadata (element-type, data-type, group-id, channel)
    index: Optional[int]         # Auto-generated sequence number
    created_time: str            # ISO 8601 timestamp
    focus: Optional[str]         # UI focus hint (editor, shell, chat)
```

**Element types** (FlowElementType enum): reasoning, chat, error, llm-end, end, status, mode, checkpoint, trace, source, result, state, user-message, prompt-echo, focus, shell-input, shell-output, cached-message, goal, todo, phase, prompt-analysis, web-app, survey, write, continue, tool-call, tool-result

**Data types** (FlowDataType enum): `TEXT` ("string"), `OBJECT` ("object"), `ENTITY` ("entity")

### Emission Path

When `entity.emit_flow_data()` is called (e.g., on AgentHook):

1. Transforms data to frontend format (element_type, data_type, content, attributes)
2. Calls `send_flow_data_to_entity()` in `flow_sdk/core/network/resource_tracker.py`
3. Sends a `flow_data_msg` over WebSocket to all active watchers:

```json
{
  "message_type": "flow_data_msg",
  "message_id": "<uuid>",
  "to_entity": "<type-id>",
  "flow_data": {
    "element_type": "webhook",
    "data_type": "object",
    "content": "<json payload>",
    "attributes": { "webhook_type": "agent_hook", "t": "..." }
  }
}
```

---

## 5. TypeScript SDK — FlowData Processing

### FlowData Class

File: `ts_sdk/src/flow_processing/flow-data.ts`

Mirrors Python and adds streaming:
- `data: T` — parsed content
- `rawData?: any` — accumulates during streaming
- `attributes: Record<string, string>`
- `ready: boolean` — fully parsed
- `parseChunk(contentChunk)` — accumulates raw data, emits `CHUNK`
- `parseElementData()` — final parse, emits `READY`

### FlowDataStream

File: `ts_sdk/src/flow_processing/flow-data-stream.ts`

Groups and consolidates FlowData items:
- **Group consolidation**: Merges chunks with same `group-id`
- **Streamable types**: reasoning, chat, shell-output, trace, cached-message
- **Deduplication**: Tracks recent chunk keys (200 items) to avoid duplicate delivery
- **Final marker**: `isFinal` or `attributes.complete='true'` closes a group

### FlowStreamProcessor

File: `ts_sdk/src/flow_processing/flow-stream-processor.ts`

XML stream parser — state machine:
1. **WaitingForStart**: Finds `<flow-{type} ...>` start tags
2. **ProcessingContent**: Accumulates content between tags
3. **WaitingForEnd**: Finds closing `</flow-{type}>` tag
4. Emits `FlowData` when complete

### FlowEvents

File: `ts_sdk/src/flow_processing/flow-events.ts`

Stream-level events: `DATA`, `DATA_START`, `DATA_END`, `STREAM_START`, `STREAM_END`, `STREAM_CANCEL`, `EXECUTION_STATUS`, `RENDER`, `ERROR`

FlowData instance events: `CHUNK`, `PARSED`, `READY`, `ERROR`

---

## 6. Bootstrap & Sniffer Lifecycle

The sniffer is **auto-enabled at bootstrap** — no user interaction required.

### Bootstrap Flow

`GET /api/v1/graph/bootstrap` always creates or returns the sniffer `AgentHook` entity. The bootstrap response includes a `sniffer_hook` field:

```json
{
  "sniffer_hook": { "id": "<uuid>", "type": "agent_hook", "uname": "sniffer", "name": "Hooks Sniffer" }
}
```

The frontend `DataContext` reads this and sets `snifferEnabled = true` immediately on page load — before any user action and without a separate `GET /api/v1/graph/hooks-sniffer` call.

### User Toggle

When the user clicks the power button in `EventSnifferChip`:

| Action | API Call |
|--------|----------|
| Enable | `POST /api/v1/graph/hooks-sniffer` → create/update AgentHook + `hook.apply()` (writes settings.json) |
| Disable | `DELETE /api/v1/graph/hooks-sniffer` → delete AgentHook + `hook.unapply()` (removes settings.json entries) |

Only **one** API call is made regardless of how many UI components are mounted — all consumers share the same `DataContext.snifferEnabled` state.

### Restart Behavior

After a server restart, bootstrap re-creates the sniffer entity and re-enables it in the DB. The hook entries in `~/.claude/settings.json` persist across restarts (they are written on `apply()` and removed on `unapply()`).

---

## 7. UI Pipeline

### Sniffer Events

```
SnifferHook class (ts_sdk/src/services/sniffer-hook.ts)
  → subscribes to entity.on('flow_data')
  → routes by element-type to named streams (taskStream, etc.)

useHooksSniffer() (ui/src/hooks/use-hooks-sniffer.ts)
  → processes FlowData into SnifferEvent[]
  → extracts session_id, cwd, hook_event_name, tool info
  → maps sessions to projects

useSnifferPipeline() (ui/src/hooks/use-sniffer-pipeline.ts)
  → scope filter (all events vs project-specific)
  → layer processors (sniffer-layers.ts) — synthetic event generation
  → level filter (info-only vs debug)
  → mask filter (by session_id)
  → time window filter (10s / 1M / 10M / 60M / 1D)

EventSnifferChip (ui/src/components/hooks/EventSnifferChip.tsx)
  → power toggle, filters, heartbeat chart, event list popover

HeartbeatEventsViewer (ui/src/components/lens-viewer/HeartbeatEventsViewer.tsx)
  → full-screen lens view with icons flowing left-to-right
```

#### Pause / Clear / Max Events

- **Pause**: `togglePause()` freezes the displayed event list at a snapshot; new events still accumulate in the underlying stream and are shown on resume.
- **Clear**: Calls `flowDataStream.clear()` and dispatches a `hooks-sniffer-clear` CustomEvent so all mounted hook instances reset together (no per-consumer desync).
- **Max events**: Defaults to 100, stored in `localStorage` under `flowpad-sniffer-max-events` (configurable 1–10000). When the stream exceeds `maxEvents`, the oldest items are spliced out and a `globalIndexOffset` counter ensures sequential `idx` numbering across trims.

#### SnifferEvent Type

```typescript
type SnifferEvent = {
  id: string;
  idx: number;
  timestamp: string;
  webhook_type: string;        // "agent_hook", "hook_op", etc.
  event_type: string;          // Derived event name
  hook_entry_id?: string;
  hook_file_path?: string;
  transcript_path?: string;
  session_id?: string;
  hook_data?: Record<string, any>;
  raw_line: string;
  layer: EventLayer;           // 'debug', 'info', 'raw_notifications', 'resource'
  summary?: string;
  warning?: string;
  error?: string;
};
```

#### Layer Processors (`sniffer-layers.ts`)

Layer processors run on every filtered event set and produce **synthetic events** that are merged and sorted back into the timeline. They add higher-level signal without modifying raw events.

| Layer | Color | What it produces |
|-------|-------|-----------------|
| `debug` | muted | All raw `agent_hook` / `hook_op` events (default) |
| `info` | cyan | Derived highlights: `TaskStart` (Task tool), `SkillUsed` (Skill tool), `SessionStart`, `SessionEnd`, `AgentComplete` (Stop), `SubagentStart`, `TaskCreated`, `TaskCompleted`, `PostToolUseFailure` |
| `raw_notifications` | emerald | `PlanReady` — fires when a `Write` tool targets `.claude/plans/*.md` |
| `resource` | green | One entry per `hook_op` event (CRUD/event/invoke/log operations) |

**Level filter** controls which layers are visible:
- `debug` (default): all layers
- `info`: only `info`, `raw_notifications`, `resource` layers (hides raw `debug` events)

Per-layer granular selection via `filters.layers: EventLayer[]` takes priority over the level filter.

### Process Streams (Agentic Processes)

```
FlowDataStream
  → useProcessStream() — useSyncExternalStore subscription
  → FlowDataRenderer — routes by elementType to components
  → TextMessageComponent, ShellMessageComponent, ReasoningMessageComponent, etc.
```

File: `ui/src/hooks/flow-hooks/useProcessStream.ts` — subscribes to `FlowEvents.DATA`, `RENDER`, `EXECUTION_STATUS`

File: `ui/src/hooks/flow-hooks/useDataStreamText.ts` — tracks individual FlowData streaming progress (CHUNK → READY)

File: `ui/src/components/flowdata-renderer/FlowDataRenderer.tsx` — enhances FlowData with UI properties, routes to component by `elementType`

---

## 8. End-to-End Diagram

```
Claude Code hook fires
  │
  ▼
Executes: flow hooks report --hook-entry-id={ID} --name={NAME}
  │
  ▼
CLI reads stdin JSON, POSTs to /api/v1/webhook/listen
  │
  ▼
listen_action() → route by webhook_type
  │
  ├──→ handle_agent_hook()
  │      AgentHook.get_by_id(ID) → process triggers → emit FlowData
  │
  └──→ _broadcast_to_sniffer()
         sniffer_hook.emit_flow_data({ flow_value, attributes })
           │
           ▼
         send_flow_data_to_entity() → WebSocket flow_data_msg
           │
           ▼
         TypeScript SnifferHook.on('flow_data') → routes to streams
           │
           ▼
         useHooksSniffer() → parses into SnifferEvent[]
           │
           ▼
         useSnifferPipeline() → scope / level / mask / time filters
           │
           ▼
         EventSnifferChip / HeartbeatEventsViewer renders
```

---

## 9. Key Files

| File | Purpose |
|------|---------|
| `server/routes/webhook.py` | Webhook route registration |
| `flow_sdk/app/actions/listen.py` | Webhook handler, broadcasts to sniffer |
| `flow_sdk/app/actions/hooks_sniffer.py` | Sniffer enable/disable/status action |
| `flow_sdk/builtin/agent_hook.py` | AgentHook entity, `is_sniffer` property, `handle_webhook()` |
| `flow_sdk/builtin/claude_settings_sync.py` | `generate_hook_command()`, sync hooks to settings.json |
| `flow_sdk/hooks/hook_file.py` | HookFile manager for reading/writing hook entries |
| `flow_sdk/hooks/models.py` | HookEntry, AgentHookMetadata data models |
| `flow_sdk/hooks/providers/claude_code.py` | ClaudeCodeHookFile provider for settings.json format |
| `flow_sdk/core/flow/models/flow_data.py` | Python FlowData model |
| `flow_sdk/core/flow/models/webhook_flow_data.py` | Webhook payload models |
| `flow_sdk/core/flow/models/hook_op.py` | HookOp payload models |
| `flow_sdk/core/network/resource_tracker.py` | `send_flow_data_to_entity()` WebSocket dispatch |
| `flow_sdk/cli/flow_cli.py` | `hooks report` CLI command (lines 595-736) |
| `ts_sdk/src/flow_processing/flow-data.ts` | TypeScript FlowData class |
| `ts_sdk/src/flow_processing/flow-data-stream.ts` | FlowDataStream grouping/consolidation |
| `ts_sdk/src/flow_processing/flow-stream-processor.ts` | XML stream parser |
| `ts_sdk/src/flow_processing/flow-events.ts` | FlowEvents constants |
| `ts_sdk/src/services/sniffer-hook.ts` | SnifferHook class, routes flow_data to streams |
| `ts_sdk/src/services/hooksSnifferService.ts` | Sniffer enable/disable/status API calls |
| `ui/src/hooks/use-hooks-sniffer.ts` | React hook: sniffer state, event parsing, filtering |
| `ui/src/hooks/use-sniffer-pipeline.ts` | Filtering pipeline: scope, layers, level, mask, time |
| `ui/src/components/hooks/EventSnifferChip.tsx` | Sniffer control panel with heartbeat chart |
| `ui/src/components/lens-viewer/HeartbeatEventsViewer.tsx` | Full-screen lens event view |
| `ui/src/hooks/flow-hooks/useProcessStream.ts` | React hook for process stream subscription |
| `ui/src/components/flowdata-renderer/FlowDataRenderer.tsx` | Routes FlowData to UI components by elementType |
