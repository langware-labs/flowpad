---
id: 49642cfd-f8dc-4b1c-9f08-430eedf56669
---

# How MCP servers connect to an agent in Flowpad

Research report — where MCP is configured, how it is stored, and how secrets are handled.
Scope: this checkout (`flow_sdk`, `ui`, `ts_sdk`). Read-only research; nothing was changed.

***

## 0. TL;DR

There are **two completely separate MCP systems** in this tree, and they share nothing but the acronym:

| <br />               | **A — Agent-facing MCP (config)**                                                    | **B — Flowpad's own MCP (runtime)**                              |
| -------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Who owns the config  | The CLI vendor (Claude Code, Codex, Cursor, …)                                       | Flowpad, in code                                                 |
| Where it lives       | `.mcp.json` / `~/.claude.json` / `.codex/config.toml` …                              | `flow_sdk/core/flow/mcp_servers/` + `flow_sdk/mcp_server/`       |
| Flowpad's role       | **Read-only observer** — indexes it into `MCP_SERVER` records and mints capabilities | Owner — starts, authenticates, and calls the servers             |
| How an agent gets it | Inherited: the spawned CLI reads its own config files                                | Injected: SDK in-process server, or HTTP MCP on the compute node |
| Secrets              | Whatever the config file's `env` block holds — **plaintext, unmanaged**              | Bearer token in the encrypted sod + `x-flow-env-*` headers       |

The critical structural fact: **Flowpad does not "attach" an MCP server to an agent.** For system A, an agent gets an MCP server because the CLI it spawns reads a config file that happens to contain one. `Agent.mcp_servers` exists as a field but is **declared-only and not projected into any launch option** (see §1.5).

***

## 1. System A — agent-facing MCP servers (the `.mcp.json` world)

### 1.1 Where they are configured (the source-file map)

The authoritative table is `flow_sdk/fs_store/indexer/functions/mcp_server.py:74-113`. Each row is
`(path parts under a root, top-level servers key, format, owning agent)`:

**Under the user home (`_HOME_SOURCES`):**

| File                                                                                                             | Key           | Format | `worker_type`    |
| ---------------------------------------------------------------------------------------------------------------- | ------------- | ------ | ---------------- |
| `~/.claude.json`                                                                                                 | `mcpServers`  | json   | `claude_code`    |
| `~/.claude/mcp.json`, `~/.claude/.mcp.json`                                                                      | `mcpServers`  | json   | `claude_code`    |
| `~/.codex/config.toml`                                                                                           | `mcp_servers` | toml   | `codex`          |
| `~/.vscode/mcp.json`                                                                                             | `servers`     | json   | `vscode`         |
| `~/.cursor/mcp.json`                                                                                             | `mcpServers`  | json   | `cursor`         |
| `~/Library/Application Support/Claude/claude_desktop_config.json` (+ win `AppData/Roaming/…`, linux `.config/…`) | `mcpServers`  | json   | `claude_desktop` |
| `~/.copilot/mcp-config.json`                                                                                     | `mcpServers`  | json   | `copilot`        |
| `~/.codeium/windsurf/mcp_config.json`                                                                            | `mcpServers`  | json   | `windsurf`       |

**Under a project root (`_PROJECT_SOURCES`):** `.mcp.json`, `mcp.json`, `.claude/mcp.json`,
`.claude/.mcp.json`, plus the shared `.codex/config.toml`, `.vscode/mcp.json`, `.cursor/mcp.json`.

Note the key differs per vendor (`servers` for VS Code, `mcp_servers` for Codex TOML) —
`_resolve_source()` (line 116) re-derives the key and worker type from the path by
longest-suffix match, and is the single source of truth shared by discovery and extraction.

### 1.2 Three scopes

| Scope     | Shape                                                                                                         | Pointer                             |
| --------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `user`    | top-level `mcpServers` under the home root                                                                    | `/mcpServers/<name>`                |
| `project` | top-level `mcpServers` in `<proj>/.mcp.json`                                                                  | `/mcpServers/<name>`                |
| `local`   | **nested** `projects["<abs cwd>"].mcpServers` in `~/.claude.json` — Claude's *default* `claude mcp add` scope | `/projects/<cwd>/mcpServers/<name>` |

Plus a fourth, non-file case: **claude.ai cloud connectors**. `~/.claude.json` carries
`claudeAiMcpEverConnected` — a flat *list of display names only*, no command/url/auth (that lives
in the cloud). Each becomes a name-only stub record under a synthetic pointer
`/claudeAiMcpEverConnected/<name>` with `connector_type: "remote"`
(`mcp_server.py:71`, `_iter_cloud_connectors` line 222).

### 1.3 How they are stored (discovery → record)

A two-stage recursive indexer walk, mirroring `claude_hook.py`:

```
roots (USER_HOME_FOLDER / REAL_PROJECT_CWD / CWD_ROOT)
  └─ mcp_source_files_fn        → MCP_SERVER_SOURCE   (one FSRef per config file, no reads)
       └─ mcp_servers_in_file_fn → MCP_SERVER          (one FSRef per server, carries json_path)
            └─ extract_mcp_server → FSRecord(type=MCP_SERVER)
```

Registered at `flow_sdk/fs_store/indexer/registrations.py:48`.

The resulting record (`extract_mcp_server`, line 344) is **agent-neutral** and persists the full
*definition site* so a future control phase can edit the exact entry:

```
id            <source_file>:<name>            (top-level, legacy-stable)
              <source_file>:<json_path>       (nested local scope + cloud stubs)
name          server name
scope         user | project | local
source_file   absolute path
json_path     RFC-6901 pointer
format        json | toml
project_path  owning project (local scope only)
command, args, env, url, transport      ← the launch payload, verbatim
worker_type   claude_code | codex | cursor | vscode | claude_desktop | copilot | windsurf
connector_type  local | remote
description   the launch line (so FTS matches on command/package/url)
```

This phase is **strictly read-only** — the vendor owns the files. `mcp_reconcile.py`'s module
docstring is explicit that index functions must never shell out.

### 1.4 How they become "capabilities" the agent system can reason about

`flow_sdk/core/capabilities/mcp.py` turns every indexed record into a dynamic capability:

* Kind: `<service>.mcp.<worker_type>` — e.g. `gmail.mcp.claude_code`. Service-first so a query for
  `gmail` or `gmail.mcp` resolves the leaf via the registry's prefix matching.

* `normalize_service()` (line 68) strips vendor prefixes (`claude.ai `, `claude_ai_`) and
  non-alphanumerics: `"claude.ai Gmail"` → `gmail`.

* `reconcile_mcp_capabilities()` (line 201) is the **single mutation seam**: registers a runner +
  upserts a system `Capability` row per `(service, worker_type)`, prunes kinds whose backing config
  disappeared, then runs discovery. Serialized by a module lock.

* Semantics are deliberately thin: `check` = *configured* (a record exists), `test` = mirrors check,
  `install` = **no-op** ("MCP servers are configured, not installed").

**Runnability gate** (`_WORKER_TYPE_TO_HARNESS`, line 44): a capability is only `runnable` when the
worker\_type maps to a harness Flowpad can actually spawn (`claude_code`/`codex`/`copilot`/`opencode`
→ `harness.*.cli`). Config-owning agents Flowpad never launches (`cursor`, `windsurf`, `vscode`,
`claude_desktop`) get **no dependency and** **`runnable=False`**, with an honest description so the
capability summary never claims the connector is usable here.

Reconcile is triggered from four places:

* boot — `flow_sdk/server/app.py:171` (background task)

* after any index of `mcp_server` — `fs_records_actions.py:1326` (fire-and-forget)

* capability summary refresh — `core/capabilities/summary.py:119`

* `Capability` entity refresh for an MCP kind — `builtin/capability.py:257`

### 1.5 How an agent actually *gets* the server at launch — the honest answer

**It doesn't, explicitly.** Three separate observations:

1. **`Agent.mcp_servers`** **is declared-only.** `flow_sdk/builtin/agent.py:100` sits inside a block
   commented `── DECLARED ONLY, not yet enforced ──` (lines 92-98): *"These round-trip through
   agent.md and are visible on the agent's card, but* *`to_agent_options`* *cannot project them: no
   AgentOptions subclass has a field to carry them, so nothing reaches the worker. Do not present
   them in a UI as if they gated anything until that lands."* It is mirrored in
   `ts_sdk/src/entities/agent.ts:72` and rendered in the agent-profile editor — presentation only.

2. **The Claude Agent-SDK worker inherits config by setting.** `code_agentic_worker.py:236` passes
   `setting_sources: ["user", "project"]`, which is what makes the SDK load the user- and
   project-scope `.mcp.json` on its own. The `mcp_servers` dict Flowpad builds at line 220 holds
   **only** an in-process SDK server (`create_sdk_mcp_server(name="flow", …)`, line 197) exposing
   one `flow_instruction` tool, and only when `context.amd_support` is on.

3. **The PTY/CLI path relies on the CLI reading its own files.** The only `--mcp-config` in the tree
   is `flow_sdk/claude_env.py:833`, used by `ClaudeEnv.loadMcp()` (line 609) which writes a
   `mcp.json` pointing at the `flow-sdk-mcp` console script — a test/harness fixture, not the
   production agent launch path.

So the wiring is: **config file on disk → the vendor CLI reads it → agent has the tool.** Flowpad
observes and reports; it does not inject.

### 1.6 The write paths that *do* exist

Three narrow ones:

* **`POST /api/v1/graph/compute_node/{id}/mcp-enable`** — `flow_sdk/app/actions/mcp_actions.py:88`.
  Body `{server, scope}`. Writes `{"type":"stdio","command":<server>,"args":[]}` into
  `data["mcpServers"][server]` of either `get_instance_settings().claude_mcp_json_path`
  (`~/.claude/mcp.json`, `instance_settings/base_settings.py:304`) or `<cwd>/.mcp.json`.
  Its sibling `mcp-available` (line 60) probes both scopes. Both are hardcoded around the
  `flow-sdk-mcp` server by default.

* **Path-based source-file CRUD** — `GET/PUT/DELETE /api/v1/graph/…/fs-records/file?path=…&json_path=…`
  (`fs_records_actions.py:2398`). Extractors live in `fs_store/source_file_records.py`
  (`_extract_mcp_json`, line 146). Guarded by an allow-list derived from the extractor table:
  filename must be one of `settings.json` / `settings.local.json` / `managed-settings.json` /
  `mcp.json` / `.mcp.json` **and** the path must contain `.claude/` or `/.mcp.json`
  (`is_allowed_source_path`, line 191). Anything else → 403.

* **The agent itself.** The intended install flow is an *agentic* one: `core/capabilities/connectors.py`
  maps a plain-language intent ("email", "slack") to a curated `install_prompt` and hands it to
  `run_capability_install_process` — a headless agent that runs `claude mcp add`, walks the OAuth,
  and verifies. After that the worker calls `flow process restart`
  (`AgenticProcess.http_self_restart`, `agentic_process.py:1979`) precisely *"to pick up a
  newly-installed MCP server"* — the restart is detached because the calling CLI is a child of the
  worker being killed.

### 1.7 Reconciliation against live state

`flow_sdk/builtin/faas/mcp_reconcile.py` — `GET /fs-records/mcp-reconcile[?use_cli=true]`
(`fs_records_actions.py:2149`). Diffs two views:

* **disk** — re-runs the indexer's own `MCP_SERVER` walk (`_walk_type_records`), so it is
  byte-for-byte what indexing produces;

* **cli** — parses `claude mcp list`. This is the **only** view that reflects live/remote state,
  notably the cloud connectors whose on-disk form is name-only.

Matching is by normalized name; returns `only_on_disk` / `only_in_cli` / `in_both`. The CLI leg is
guarded by `shutil.which`, capped at 10s, and fail-soft (`cli_unavailable` / `cli_timeout` /
`cli_error` markers, never raises).

### 1.8 UI surfaces

* **Project resources** — `ui/src/components/project-resource-list/build-resource-items.ts:83`
  renders `mcp_servers` from the per-project scan (`scan_indexer.py:318`).

* **System profile** — `McpServerItem` (`system_profile_types.py:114`) carries `command`, `args`,
  `env`; `summary.mcpServers` counts them.

* **Settings** — `ui/src/components/settings-view/settings-utils.ts:611-637` exposes Claude's own
  gates: `enable_all_project_mcp_servers`, `enabled_mcpjson_servers`, `disabled_mcpjson_servers`.
  These are Claude Code settings Flowpad edits, not Flowpad concepts.

* **Agent profile editor** — `agent-document.ts:20` lists `mcp_servers` as an agent.md field
  (see §1.5 caveat).

***

## 2. System B — Flowpad's own MCP servers

### 2.1 The sandbox servers (`shell_mcp`, `fs_mcp`)

`flow_sdk/core/flow/mcp_server.py` — the `MCPConnector` dataclass (line 273).

**Lifecycle:**

1. `initialize()` mints/loads a bearer token, opens a compute-node session, and — if not already
   healthy — copies every `.py` under `core/flow/mcp_servers/copy_to_sandbox/` to
   `<workdir>/.mcp_servers/` on the node and starts the two listed in `MCP_SERVERS_TO_START`
   (`shell_mcp.py` on **:8101**, `fs_mcp.py` on **:8102**) via
   `FLOWPAD_MCP_TOKEN=… fastmcp run … --transport streamable-http --host 0.0.0.0 --port N`
   (line 470; a PowerShell `$env:` variant on Windows).
2. Startup is awaited by reading stderr until `"Application startup complete."`.
3. Health is a two-step probe: unauthenticated reachability, then an authenticated round-trip that
   must return 2xx and carry an `mcp-session-id` (`test_mcp_health_no_auth` / `test_mcp_health_auth`).
4. `MCPConnectorPool` (line 545) keeps warm connectors — **disabled for** **`LOCAL_MACHINE`**.

**Client side:** `FlowPadMCPServer` extends pydantic-ai's `MCPServerStreamableHTTP` and adds
`call_tool_with_progress_timeout` (line 87) — the read timeout resets on every progress
notification, so a tool streaming shell output for a long time doesn't time out. Shell tool calls
route through `_create_shell_tool_call_with_progress` (line 228), which parses progress JSON and
forwards `stdout`/`stderr` to the session's callback handler.

**Teardown is platform-aware** (`_close_mcp_servers`, line 330): `taskkill /F /IM fastmcp.exe` on
Windows-local, `pkill -9 -f 'fastmcp run'` on posix-local (explicitly *not* port-based, to avoid
killing the parent backend), and `lsof … | xargs kill -9` only on remote nodes.

`.mcp_servers/` is git-ignored and backed up/restored around checkouts
(`flow_source_control.py:113-172`) so a branch switch doesn't force a re-copy.

### 2.2 The stdio server (`flow-sdk-mcp`)

`flow_sdk/mcp_server/` — a FastMCP stdio server registered as the console script
`flow-sdk-mcp = "flow_sdk.mcp_server:run"`. Five tools: `flow_ping`, `flow_entity_crud`, `flow_tag`,
`flow_context`, `session_analysis` (a sixth, `workflow_trace`, is defined but deliberately not
registered). Fully documented in `docs/data-management/mcp-operations.md`. Auth is **none** —
subprocess trust. This is the server `mcp-enable` writes into `.mcp.json`, i.e. the one bridge
between system B and system A.

### 2.3 In-process SDK server

`code_agentic_worker.py:197` — `create_sdk_mcp_server(name="flow", …)` exposing `flow_instruction`
(set/get/exception against the run's `stack_frame`). Lives entirely in the worker process; no
transport, no auth surface.

***

## 3. Secrets management

Three unrelated stories. Do not conflate them.

### 3.1 The Flowpad↔sandbox MCP bearer token

`MCPConnector._initialize_mcp_server_token` (`mcp_server.py:311`):

* **Local machine** → the literal constant `"local_machine_mcp_token"`. No secret at all.

* **Remote node** → key `build_sod_key(compute_node.typeid, "mcp_server_sod")` in the per-instance
  **sod** store; on `KeyError`, mints `secrets.token_urlsafe(32)` and writes it back.

The token rides as `Authorization: Bearer …` (`_mcp_server_headers`, line 500) and is validated
server-side by `TokenAuthProvider.load_access_token` (`copy_to_sandbox/mcp_auth.py`), which is a
plain string equality against `FLOWPAD_MCP_TOKEN` — an `OAuthProvider` subclass where every other
method raises `NotImplementedError`. `shell_mcp` strips `FLOWPAD_MCP_TOKEN` from the env it hands
to spawned shells (`shell_mcp.py:85`).

Known debt: `# TODO [FLOWPAD-1051] Decouple sod storage from MCP server token`.

### 3.2 Project secrets → the sandbox shell (the `x-flow-env-*` channel)

Chain:

```
SecretOrigin (pointer only)  →  driver.resolve()  →  SecretStr
   → FlowEnv (SecretStr-valued)
     → x-flow-env-<name> HTTP headers on the shell MCP client   (mcp_server.py:511)
       → get_environment_variables() re-uppercases them          (shell_mcp.py:55)
         → merged into the shell session's env                   (shell_mcp.py:86)
```

Design points worth keeping:

* **`SecretOrigin`** **is a value-free pointer** (`builtin/secret_origin.py`). `assert_value_free()`
  raises on any `value`/`plaintext`/`digest`-shaped key at any depth, so a regression that tries to
  put a value in a reference json or a share payload fails loudly.

* **One resolver, two transports** (`builtin/secret_origin_resolver.py` docstring): the same
  `resolve_project_secrets()` feeds both the worker's process env dict
  (`apply_worker_secret_env`, `cli_worker_base_driver.py:555`) and the compute-node
  `list[FlowEnv]` (`resolve_node_secret_env`, `env_context.py:116`).

* Locator kinds: `local` (sodot), `env-local`, `gcp`, `1password`, `flowpad-hub`
  (`builtin/*_secret_ref.py`, dispatched by `secret_origin_driver.py`).

* **Node attachment gates** which env vars resolve (`attached_env_vars_for`); `None` = uncurated =
  everything, so pre-attachment setups are unchanged.

* Per-secret failures are swallowed and **logged by name, never by value**.

* `setdefault`, not assignment — an explicitly-set env var wins over a resolved secret.

* Values ride the per-command prefix and are **never written to the node's filesystem**;
  `set_env` stays reserved for `FLOWPAD_*` proxy config.

Store itself: values live in the per-instance encrypted `sodot` (Fernet), key in the OS keychain
under `Flowpad.ai.sod_key`/`<instance>`, behind a consent marker `<instance_dir>/.secrets_enabled`
(`flow_sdk/cli/auth/secrets.py`). `read_secret` is **SDK-only, never exposed over HTTP**. On
Electron the signed launcher owns the keychain entry (`<instance>.flow-rs` slot) and hands the key
to Python via `seed_sod_key` so Python never calls `keyring.set_password`.

### 3.3 Secrets in an agent's MCP config — **unmanaged**

This is the gap. The `env` block of a `.mcp.json` entry is copied **verbatim** onto the record:

```python
env=body.get("env", {}) or {},        # mcp_server.py:404
```

and surfaced verbatim through `McpServerItem.env` (`system_profile_types.py:120`) into the system
profile and the project resource list. There is no masking, no `mask_confidential_value()` call, no
`SecretStr`, and no interpolation from `SecretOrigin`/sodot on this path. A user who pastes an API
key into `~/.claude/mcp.json` has that key indexed into the FS-record store and served over the
graph API alongside `command` and `args`.

Similarly, `mcp-enable` writes a fixed `{"type":"stdio","command":…,"args":[]}` with no `env` at
all, and the claude.ai cloud connectors are name-only stubs — their credentials live entirely in
Anthropic's cloud and are invisible to Flowpad by construction.

The one place secrets *do* reach an agent's MCP server today is indirectly: `apply_worker_secret_env`
injects resolved project secrets into the worker's spawn env, and a **stdio** MCP server started by
that worker inherits the process env. That is inheritance, not management — it doesn't cover HTTP/SSE
servers, and nothing declares the dependency.

***

## 4. Gaps and risks

1. **`Agent.mcp_servers`** **is a lie in waiting.** It renders on the agent card and round-trips through
   `agent.md`, but nothing projects it into `AgentOptions`. Any UI that presents it as a gate is
   wrong until `to_agent_options` grows a carrier. (The code comment says exactly this — worth
   keeping visible.)
2. **MCP** **`env`** **is indexed and served in plaintext.** No masking anywhere on the path
   record → API → UI. If any of this is shared to the hub, audit the sharing classification of the
   `mcp_server` record type.
3. **`"local_machine_mcp_token"`** **is a constant.** Any local process can drive the shell/fs MCP on
   :8101/:8102 (bound `0.0.0.0`). Acceptable for a local-trust model; worth stating explicitly
   rather than leaving implicit.
4. **`connector_type`** **is inferred, not declared** — `"remote"` iff cloud stub or url-without-command.
   A stdio server that also declares a `url` would be mis-typed.
5. **Capability naming is best-effort by design.** `normalize_service` collapses
   `"Google_Calendar"` → `googlecalendar`; two differently-named servers can merge into one
   capability. The docstring owns this ("the precise ontology is intentionally best-effort"), but it
   means capability identity is not a stable key.
6. **No control phase yet.** Records persist the full definition site (`source_file` + `json_path` +
   `format` + `scope`) explicitly so a future writer can update the exact entry — but the only
   writers today are `mcp-enable` (one hardcoded server) and the generic source-file PUT (allow-list
   limited to Claude paths; Codex TOML and Cursor/Windsurf/VS Code configs are read-only).

***

## 5. File map

**System A — config, discovery, capabilities**

```
flow_sdk/fs_store/indexer/functions/mcp_server.py   source table, 2-stage walk, extract_mcp_server
flow_sdk/fs_store/indexer/registrations.py:48       registration
flow_sdk/fs_store/source_file_records.py:146        _extract_mcp_json + allow-list
flow_sdk/core/capabilities/mcp.py                   <service>.mcp.<worker_type>, reconcile
flow_sdk/core/capabilities/connectors.py            intent → curated install prompt
flow_sdk/builtin/faas/mcp_reconcile.py              disk vs `claude mcp list`
flow_sdk/builtin/faas/scan_indexer.py:318           per-project resource walk
flow_sdk/builtin/faas/system_profile_types.py:114   McpServerItem
flow_sdk/app/actions/mcp_actions.py                 mcp-available / mcp-enable
flow_sdk/builtin/agent.py:100                       Agent.mcp_servers (declared only)
ui/src/components/project-resource-list/…           project resource rendering
ui/src/components/settings-view/settings-utils.ts   Claude's enable/disable settings
```

**System B — Flowpad's own servers**

```
flow_sdk/core/flow/mcp_server.py                    MCPConnector, FlowPadMCPServer, pool
flow_sdk/core/flow/mcp_servers/copy_to_sandbox/     shell_mcp.py, fs_mcp.py, mcp_auth.py
flow_sdk/mcp_server/                                flow-sdk-mcp stdio server (5 tools)
flow_sdk/builtin/agentic_process/cli_drivers/claude/code_agentic_worker.py:197
flow_sdk/claude_env.py:604-620, 833                 test harness --mcp-config
```

**Secrets**

```
flow_sdk/builtin/secret_origin*.py                  pointer entity, locators, drivers, resolver
flow_sdk/core/flow/models/execution/env_context.py  FlowEnv, resolve_node_secret_env
flow_sdk/builtin/agentic_process/cli_drivers/cli_worker_base_driver.py:555  worker spawn env
flow_sdk/cli/auth/secrets.py                        sodot, consent gate, keychain, recovery
flow_sdk/instance_settings/base_settings.py:148,304 claude_mcp_json_path
```

**Docs**

```
docs/data-management/mcp-operations.md              flow-sdk-mcp tools reference
docs/debugMCP-setup.md                              debugMcp / playwright CDP setup
docs/mcp-ui.md                                      MCP Apps / MCP UI (unrelated to the above)
```

