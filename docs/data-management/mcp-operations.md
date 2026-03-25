# MCP Server Operations

The `flow_sdk` MCP server exposes a set of tools that Claude Code can call from within a running session. These tools allow in-session agents to record entities, report progress via XML flow tags, manage per-session key-value context, and introspect session transcripts — all over the MCP stdio protocol rather than through the HTTP graph API.

## Entry Point and How the Server Starts

The MCP server is started as a subprocess by Claude Code. Two launch paths exist.

### Normal launch (FastMCP)

```bash
python -m flow_sdk.mcp_server
```

`__main__.py` imports `run` from `flow_sdk.mcp_server` (the `__init__.py`) and calls it:

```python
# flow_sdk/mcp_server/__init__.py
from fastmcp import FastMCP
from flow_sdk.mcp_server.mcp_api import flow_ping, flow_entity_crud, flow_tag, flow_context, session_analysis

session_store = ContextStore()
known_rules_store = ContextStore()

mcp = FastMCP("flow_sdk")

mcp.tool()(flow_ping)
mcp.tool()(flow_entity_crud)
mcp.tool()(flow_tag)
mcp.tool()(flow_context)
mcp.tool()(session_analysis)

def run():
    mcp.run(transport="stdio")
```

`FastMCP` (the `fastmcp` library) wraps each registered function, derives its tool name, description, and JSON Schema from Python type annotations and docstrings, and handles the JSON-RPC framing automatically.

The server is registered as a console script in `pyproject.toml`:

```
flow-sdk-mcp = "flow_sdk.mcp_server:run"
```

### Debug launch (raw protocol)

```bash
python -m flow_sdk.mcp_server --debug
```

`__main__.py` detects `--debug` in `sys.argv` and imports `run` from `flow_sdk.mcp_server.debug` instead. The debug server is a minimal hand-written JSON-RPC loop in `debug.py` that speaks the same MCP wire protocol but without `fastmcp`. It only registers `flow_ping` and is intended for protocol-level debugging, not production use.

### Transport

Both modes use **stdio** transport. Claude Code spawns the server process and communicates over stdin/stdout using the [MCP protocol](https://spec.modelcontextprotocol.io/) (JSON-RPC 2.0 framing). No HTTP port is involved. In the debug mode, both newline-delimited JSON and `Content-Length`-framed messages are accepted.

## Tool Registration Pattern

MCP tools differ from the graph API action system in three key ways:

| Aspect | MCP Tools | Graph API Actions |
|--------|-----------|-------------------|
| Protocol | JSON-RPC 2.0 over stdio | HTTP REST |
| Authentication | None (subprocess trust) | Auto-auth as `@local` owner via `RequestTransactionMiddleware` |
| Registration | `mcp.tool()(func)` — wraps a plain Python function | `@action.all()` / `@action.get()` / `@action.post()` decorators on entity methods |
| Schema | Derived from Python type annotations and docstrings | Defined by HTTP method + URL pattern + Pydantic models |
| Calling convention | MCP `tools/call` request with `arguments` dict | HTTP request to `/api/v1/graph/{type}/{id}/{action}` |

Tools are registered by passing a callable to `mcp.tool()()`. The tool name exposed to Claude Code is the Python function name (`flow_ping`, `flow_entity_crud`, etc.). The description and parameter schema are derived automatically by `FastMCP` from the function signature and docstring.

## Registered Tools

All five tools are defined in `flow_sdk/mcp_server/mcp_api.py` and registered in `flow_sdk/mcp_server/__init__.py`.

### `flow_ping`

**Purpose:** Health check. Confirms the MCP server process is running and returns the installed SDK version.

**Parameters:** None.

**Returns:** A string of the form `"flow_sdk <version> connected"`.

**Implementation:**

```python
def flow_ping() -> str:
    from flow_sdk import __version__
    return f"flow_sdk {__version__} connected"
```

**Usage:** Called by Claude Code at session start to verify the MCP server is available before using any other tools.

---

### `flow_entity_crud`

**Purpose:** Perform a CRUD operation on a flow entity record. Called whenever the in-session agent creates, reads, updates, or deletes a tracked flow entity (skill, task, rule, artifact, session, etc.).

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `claude_session_id` | `str` | Yes | The session ID injected into the system prompt at session start. Used to associate the entity operation with the current session. |
| `crud` | `str` | Yes | One of `"create"`, `"read"`, `"update"`, or `"delete"`. |
| `entity_json` | `str` | Yes | JSON-encoded string representing the entity. Must contain at least a `"type"` field. `"id"` is required for `read`, `update`, and `delete` operations. |

**Returns:** A result message string. On success, the return value comes from `skillit_records.entity_crud()`. On error, returns a string beginning with `"Error: "` — including `"Error: session ID is required"` when `claude_session_id` is empty.

**Routing to handler:**

1. `entity_json` is parsed with `json.loads()`. A `json.JSONDecodeError` returns an error string immediately.
2. `plugin_records.skillit_records` is imported at call time. If the package is not installed, the function returns an informational stub message (`"entity_crud {crud} received for {type} (plugin_records not available)"`) rather than raising.
3. If `plugin_records` is available, control passes to:

```python
from plugin_records.skillit_records import skillit_records
return skillit_records.entity_crud(
    session_id=claude_session_id,
    crud=crud,
    entity=entity_dict,
)
```

The `plugin_records` package is an optional extension not included in the core `flow_sdk`. When absent, the MCP server degrades gracefully — entity CRUD calls are acknowledged but not persisted.

**Example call:**

```json
{
  "method": "tools/call",
  "params": {
    "name": "flow_entity_crud",
    "arguments": {
      "claude_session_id": "abc-123",
      "crud": "create",
      "entity_json": "{\"type\": \"skill\", \"name\": \"parse_csv\"}"
    }
  }
}
```

---

### `flow_tag`

**Purpose:** Report a progress event to FlowPad by forwarding an XML `<flow-*>` tag. Called whenever the agent produces a flow XML tag in its output.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `flow_tag_xml` | `str` | Yes | The outer XML string of the flow tag, e.g. `<flow-skill_ready data-type="string">my_skill</flow-skill_ready>`. |
| `claude_session_id` | `str` | No | The session ID. Required for `skill_ready` event side effects; optional for other event types. |

**Returns:** A confirmation string such as `"Flow tag skill_ready: sent"` or `"Flow tag skill_ready: skipped (FlowPad unavailable)"`.

**XML parsing:**

The XML string is parsed by `flow_sdk.discovery.notify.xml_str_to_flow_data_dict()`. This function:

1. Parses the XML with `xml.etree.ElementTree`.
2. Requires the root element tag to start with `"flow-"`. The suffix becomes `element_type` (e.g. `"skill_ready"` from `<flow-skill_ready>`).
3. Reads the `data-type` attribute (defaults to `"string"`). When `data-type` is `"object"`, `"json"`, or `"entity"`, the element text is parsed as JSON.
4. Reads optional `i` attribute as `index` (int) and `t` attribute as `created_time`.
5. Applies `html.unescape()` to all text content before storing in `flow_value` (including before JSON parsing for object/json/entity types). This means XML-encoded characters like `&lt;`, `&amp;`, and `&quot;` are decoded in the resulting dict.

**Recognized event types:**

| `element_type` | Description |
|----------------|-------------|
| `started_generating_skill` | Claude has begun generating a skill definition. |
| `skill_ready` | A skill has been fully generated and is ready for processing. Triggers the `skill_creation_handler.on_update()` side effect if `plugin_records` is available. |

Any other `flow-*` tag name is forwarded to FlowPad without a local side effect.

**`skill_ready` side effect:**

When `element_type == "skill_ready"` and a `claude_session_id` is provided:

```python
from plugin_records.crud_handlers.skill_creation_handler import skill_creation_handler
from plugin_records.skillit_records import skillit_records

session = skillit_records.get_session(claude_session_id)
if session:
    skill_creation_handler.on_update(
        claude_session_id, session, "skill", {"status": "new"}
    )
```

**FlowPad notification:**

After local processing, `send_flow_tag(flow_data)` is called. This sends a `hook_op` webhook to the FlowPad server (if running) as a fire-and-forget subprocess POST:

```json
{
  "webhook_type": "hook_op",
  "webhook_payload": {
    "resource_type": "skill",
    "type": "skill",
    "id": "<uuid4>",
    "operation": "event",
    "ref_type": "data",
    "data": {
      "event_name": "flow_tag",
      "event_data": { "element_type": "skill_ready", ... }
    },
    "execution_scope": []
  }
}
```

The `id` field is a fresh UUID4 generated per call. The `ref_type` field defaults to `"data"`. The `execution_scope` field is a JSON array parsed from the `FLOWPAD_EXECUTION_SCOPE` environment variable (defaults to `[]` if unset or unparseable). Note that `resource_type` and `type` are always `"skill"` regardless of the actual `element_type` in the flow tag — to discriminate event kinds, consumers must inspect `data.event_data.element_type`.

If FlowPad is not running or is rate-limited, the notification is silently skipped and the return value reflects `"skipped (FlowPad unavailable)"`.

**Example call:**

```json
{
  "method": "tools/call",
  "params": {
    "name": "flow_tag",
    "arguments": {
      "flow_tag_xml": "<flow-skill_ready data-type=\"string\">parse_csv</flow-skill_ready>",
      "claude_session_id": "abc-123"
    }
  }
}
```

---

### `flow_context`

**Purpose:** Manage session-specific key-value context storage. Provides persistent in-process storage scoped to each session, allowing the agent to read and write arbitrary string values during a session.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `claude_session_id` | `str` | Yes | Session identifier. All reads and writes are isolated by this ID. |
| `action` | `str` | Yes | Either `"get"` or `"set"`. |
| `key` | `str` | Yes | The context key to read or write. |
| `value` | `str` | Conditional | The value to store. Required when `action == "set"`. Ignored for `"get"`. |

**Returns:**

- `"set"`: Returns `"Set {key}"` on success.
- `"get"`: Returns the stored string value, or `"Error: key '{key}' not found for session {session_id}"` if the key has not been set.
- Any validation failure returns a string beginning with `"Error: "`. Specific validation errors: `"Error: session_id is required"` (empty session), `"Error: action must be 'get' or 'set', got '...'"` (invalid action), `"Error: key is required"` (empty key), `"Error: value is required for 'set' action"` (missing value on set).

**Storage mechanism:**

Two `ContextStore` singleton instances are created at module import time in `flow_sdk/mcp_server/__init__.py`:

```python
session_store = ContextStore()
known_rules_store = ContextStore()
```

`ContextStore` (`flow_sdk/mcp_server/context_store.py`) is a thread-safe in-memory dict keyed by `(session_id, key)` tuples, protected by a `threading.Lock`:

```python
class ContextStore:
    def __init__(self) -> None:
        self._data: dict[tuple[str, str], str] = {}
        self._lock = threading.Lock()

    def set(self, session_id: str, key: str, value: str) -> str: ...
    def get(self, session_id: str, key: str) -> str: ...
```

**Store routing:** The key `"known_rules"` is routed to the dedicated `known_rules_store`. All other keys use `session_store`:

```python
stores = {"known_rules": known_rules_store}
store = stores.get(key, session_store)
```

**Scope:** Context is in-process and in-memory only. Data does not persist across MCP server restarts.

**Example calls:**

```json
{
  "method": "tools/call",
  "params": {
    "name": "flow_context",
    "arguments": {
      "claude_session_id": "abc-123",
      "action": "set",
      "key": "theme",
      "value": "dark"
    }
  }
}
```

```json
{
  "method": "tools/call",
  "params": {
    "name": "flow_context",
    "arguments": {
      "claude_session_id": "abc-123",
      "action": "get",
      "key": "theme"
    }
  }
}
```

---

### `session_analysis`

**Purpose:** Return a structured view of the current session's transcript for self-analysis. Supports two modes: a full session summary (all entries as a numbered log) and a detailed view of a single entry by index.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `claude_session_id` | `str` | Yes | The session ID to look up. Searched across all projects under `~/.claude/projects/`. |
| `index` | `int` | Yes | `-1` to return the full session summary log. `0` or greater to return details for the specific filtered entry at that position. |

**Returns:**

- `index == -1`: Returns `session.summary_log` — a newline-joined string of one-line summaries for all filtered transcript entries, formatted as `"[   1]  <summary>"`.
- `index >= 0`: Returns a string of the form `"Entry {index} summary: {entry.summary}\nFull content: {entry.content}"`.
- If the session is not found: `"Error: session {claude_session_id} not found"`.
- If the index is out of range: `"Error: index {index} out of range for session with {n} entries"`.

**Data source:**

The tool reads directly from the Claude Code session JSONL files on disk:

```python
from flow_sdk.fs_records.claude import ClaudeRootFsRecord

claude = ClaudeRootFsRecord.default()
session = claude.get_session(claude_session_id)
```

`ClaudeRootFsRecord.default()` points to `~/.claude/projects/`. `get_session()` scans all project subdirectories for a file named `{session_id}.jsonl` and parses it via `ClaudeSessionFsRecord.from_jsonl()`.

**Filtered entries:** The `session.filtered_entries` property excludes entry types in `EXCLUDED_ENTRY_TYPES = ["file-history-snapshot", "progress"]`. Index values in `session_analysis` refer to positions in this filtered list, not the raw transcript.

**Summary log format example:**

```
[   1]  user: implement a CSV parser
[   2]  assistant: tool: Read(file_path) | I'll read the file first...
[   3]  turn completed in 1423ms
[   4]  assistant: tool: Write(file_path, content)
```

**Example call:**

```json
{
  "method": "tools/call",
  "params": {
    "name": "session_analysis",
    "arguments": {
      "claude_session_id": "abc-123",
      "index": -1
    }
  }
}
```

## MCP Configuration in .mcp.json

Claude Code reads MCP server configuration from two locations:

- **User-level:** `~/.claude/mcp.json`
- **Project-level:** `.mcp.json` or `.claude/mcp.json` at the project root

Both files use the same format:

```json
{
  "mcpServers": {
    "flow-sdk": {
      "type": "stdio",
      "command": "flow-sdk-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

Alternatively, using `python -m`:

```json
{
  "mcpServers": {
    "flow-sdk": {
      "type": "stdio",
      "command": "python",
      "args": ["-m", "flow_sdk.mcp_server"]
    }
  }
}
```

The `flow-sdk-mcp` console script is registered in `pyproject.toml` and points to `flow_sdk.mcp_server:run`.

The SDK parses `.mcp.json` files via `ClaudeMcpJsonRecordList` (`flow_sdk/fs_records/claude/claude_mcp_json.py`), which extracts each `mcpServers.<name>` entry into a `ClaudeMcpServerFsRecord` with fields `server_name`, `server_type`, `command`, `args`, `env`, `url`, and `scope`.

The `scope` field distinguishes user-level from project-level servers. A server entry from `~/.claude/mcp.json` gets `scope="user"`; one from `.mcp.json` in a project directory gets `scope="project"`.

## MCP Tools vs Graph API Actions

The MCP tools and the HTTP graph API cover different operational needs:

| | MCP Tools | Graph API (`/api/v1/graph/`) |
|---|---|---|
| **Transport** | JSON-RPC 2.0 over stdio | HTTP/1.1 REST |
| **Caller** | An active Claude Code session (in-process) | Any HTTP client (browser, SDK, test runner) |
| **Auth** | None — process-level trust | Auto-auth as `@local` owner |
| **Schema source** | Python function annotations + docstrings | HTTP method + URL pattern + Pydantic models |
| **Primary use** | Agent self-reporting, context, session introspection | Entity CRUD, file system, custom actions |
| **Response format** | Plain string (returned as MCP `text` content block) | `ApiResponse` JSON envelope (`status`, `message`, `data`) |
| **Entity CRUD** | `flow_entity_crud` (delegates to `plugin_records`) | `@action.all` CRUD actions in `graph_crud_actions.py` |

The `flow_entity_crud` MCP tool is not a replacement for the graph API's entity CRUD. It targets a separate `plugin_records` subsystem that tracks skill/task records from within Claude Code sessions. The graph API targets the core `flow_sdk` entity model stored in the SQLite database. Critically, `flow_entity_crud` does not write to the core Entity model, the SQLite database, or the FTS5 search index — it is an entirely independent data path. Entities created via this tool will not appear in `GET /api/v1/search` results or in graph API queries.

## Logging

All tool implementations call `flow_sdk.utils.log.skill_log()` to write diagnostic messages. Logging is independent of the MCP stdio transport — `skill_log` writes to a log file or stderr, not to stdout, so it does not corrupt the JSON-RPC stream.
