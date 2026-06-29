---
id: 4c405bbb-553d-5d0f-a818-74ba7df07133
---

# On-Disk Folder Layout

This document describes the complete on-disk structure used by flow-cli: the per-instance FlowPad home (`~/.flow/instances/<name>/`), the Claude Code directories (`~/.claude/`), all `RecordType` constants, and the source-file security check.

## FlowPad Home and Records Root

### Per-Instance Layout

flow-cli is multi-instance. All per-instance state lives under a named subdirectory of `~/.flow`:

```
~/.flow/instances/<name>/
```

The instance name resolves to `prod` by default; `dev` and `test` modes select their own names, and an arbitrary name (e.g. `oss`, `app`, `stage`) can be passed via the `FLOW_INSTANCE` env var. This checkout runs as the `oss` instance. Resolution and every per-instance path live in `flow_sdk/instance_settings/` (`base_settings.py` → `BaseInstanceSettings`), reached only through `get_instance_settings()`. Direct `Path.home() / ".flow" / X` construction elsewhere is a contract violation.

Owned (writable) FlowPad records live under the per-instance records root:

```
~/.flow/instances/<name>/records/
```

This is `InstanceSettings.records_root`, computed in `_resolve_records_root_in(instance_dir)` (`base_settings.py`) as `instance_dir / "records"`, overridable via the `FS_RECORD_PATH` env var.

The path helpers are in `flow_sdk/fs_store/record_paths.py` (`flow_sdk/fs_store/record.py` was deleted in the Phase-5 refactor):

```python
get_default_records_root()        # -> InstanceSettings.records_root
get_default_records_data_root()   # -> InstanceSettings.records_data_dir
set_default_records_root(path)    # test-only override
```

`get_default_records_root()` / `set_default_records_root()` delegate to `instance_settings`. The companion `records_data/` root (`InstanceSettings.records_data_dir = instance_dir / "records_data"`) holds the user-facing asset content for types whose `asset_ref` is not a folder under the user's project scope (see below).

### Folder Naming Convention

Each record occupies its own subdirectory (the "shadow" folder). The directory name follows the pattern:

```
<type>-@<uid>
```

Examples: `task-@f822d496-f6f0-40b7-b18f-64669be1b766`, `agentic_process-@7d1ae3db-...`, `claude_error-@a3b7f91c2e1d`.

The separator is `-@` (defined as `_NAME_SEP` in `record_paths.py`, also in `fs_record.py`). `record_stem()` builds this name and `parse_record_stem()` splits it back apart (both in `record_paths.py`).

Records are organized by type under the records root:

```
~/.flow/instances/<name>/records/
  <type>/
    <type>-@<uid>/
      metadata.json                    # ALL persisted fields (flat): type, id, name + domain fields
      <epoch>_<hexdigest>.hash         # index sentinel (zero-byte)
```

The shadow folder of an `FSRecord` (`flow_sdk/fs_store/fs_record.py`) lives at `<records_root>/<type>/<type>-@<id>/metadata.json`. The class header is explicit that `Record` (the old split-format class) was removed; `FSRecord` is the lean replacement.

### Record Metadata File (Single Flat File)

There is no `_data.json` / `state.json` split anymore, and no `data/` subfolder. Everything persisted to disk lives in one file:

```
<type>-@<uid>/metadata.json     # identity + domain fields, flat (NOT wrapped in {"data": ...})
```

`metadata.json` holds `type`, `id`, `name`, and every non-system meta field as top-level keys. A real example:

```json
{
  "type": "task",
  "id": "f822d496-f6f0-40b7-b18f-64669be1b766",
  "name": "Analyze invite and share task email flows",
  "status": "to_do",
  "task_type": "Task",
  "source_file": "/.../tasks/.../header.json",
  "scope": "project",
  "project_id": "56713622-...",
  "updated_date": "2026-06-01 19:16:35.866973+00:00"
}
```

Constants in `fs_record.py`:

```python
_METADATA_JSON = "metadata.json"
_HASH_GLOB = "*.hash"
_SYSTEM_ATTRS = frozenset({"type", "id", "_asset_ref"})
```

Which meta fields are mirrored is driven by the registered `TypeInfo.meta_model` (a pydantic model) when present; otherwise meta is a free-form dict view.

### The `asset_ref` (user-facing source file)

`FSRecord.asset_ref` is an `FSRef` to the primary user-facing content file, which lives **outside** the shadow folder — under the user's project scope or under `records_data/`. The path is resolved by `FSRecord.compute_asset_ref(scope_root, entity)`, which reads `TypeInfo.main_subdir` and `TypeInfo.main_layout`:

```python
base = Path(scope_root) / info.main_subdir
target = base / safe if info.main_layout == "folder" else base / f"{safe}.md"
```

Types with no `main_subdir` have no asset file. Examples of `main_subdir` / `main_layout` (see `flow_sdk/schema/type_info/*_info.py`): `skill` → `.claude/skills` / `folder`; `markdown` and `markdown_index` → `docs` / `file`. Only the `asset_ref` path is persisted (as `source_file` in `metadata.json`); the shadow-folder path is computed at runtime.

### Index Sentinel (`.hash`)

The single per-record `<epoch>_<hexdigest>.hash` zero-byte file in the shadow folder marks the last-indexed fingerprint. Its absence is what makes a record need re-indexing. There is no separate `state.json` cache.

See [record-model.md](record-model.md) for the full `FSRecord` / `TypeInfo` model.

---

## Querying entities by folder

Given a directory on disk, `Entity.assets_by_path(PathQueryOptions)` returns
the entities whose `asset_ref` lives under that directory (descendants at
any depth). The HTTP wrapper is
`GET /api/v1/assets/by-path?folder=<abs>&record_type=<type>` —
both query parameters are repeatable, so you can union multiple folders or
narrow to multiple types in a single call.

This is the entity-side counterpart to the on-disk layout above: when the
on-disk tree changes, indexed `asset_ref` values change with it, and the
folder query stays consistent. The query reads `asset_ref` only and uses a
half-open lex range — see
[Record Model § asset_ref and folder queries](record-model.md#asset_ref-and-folder-queries)
for the storage rule (canonical POSIX) and the SQL pushdown details.

---

## Claude Code Directories

Claude Code stores its own data under `~/.claude/`. flow-cli reads (and in some cases writes) these directories.

### Directory Overview

```
~/.claude/
  .claude.json                       # Global account / feature-flag settings
  settings.json                      # User-level Claude Code settings
  settings.local.json                # User-level local overrides (gitignored)
  managed-settings.json              # IT-deployed managed restrictions
  history.jsonl                      # Global prompt history
  projects/
    <encoded-cwd>/                   # One dir per working directory
      <session-uuid>.jsonl           # Session transcript
      ...
  commands/
    <name>.md                        # User-level slash commands
  plans/
    <slug>.md                        # Saved plan-mode plans
  todos/
    <session-id>-agent-<session-id>.json   # Session todo lists
  debug/
    <session-uuid>.txt               # Debug logs with hook/runtime errors
  plugins/
    cache/
      <marketplace>/
        <plugin-name>/
          <version-hash>/            # Cached plugin install
    installed_plugins.json           # Plugin registry
  mcp.json                           # User-level MCP server configuration
```

### Project Directories

The projects directory is `InstanceSettings.claude_projects_dir` (`claude_home / "projects"`, default `~/.claude/projects`). There is no longer a `_DEFAULT_PROJECTS_DIR` constant or a `claude_root.py` module; the indexer reads the path through `get_instance_settings().claude_projects_dir` (see `flow_sdk/fs_store/indexer/functions/_claude_projects.py`).

Each subdirectory under `projects/` corresponds to a working directory. The directory name is the absolute filesystem path with `/` replaced by `-`. The leading `/` is stripped and the remainder is prefixed with `-`:

- Working directory `/home/alice/myproject` → `~/.claude/projects/-home-alice-myproject/`
- Working directory `/Users/alice/Documents/dev/flow-cli` → `~/.claude/projects/-Users-alice-Documents-dev-flow-cli/`

`decode_claude_project_dir()` (in `_claude_projects.py`) reverses the encoding, preferring the `cwd` recorded inside the session JSONL and falling back to the encoded-name decode (which also handles Windows drive-letter prefixes).

Each project directory contains JSONL session transcript files named `<session-uuid>.jsonl`.

### Session Transcripts

Session transcripts are JSONL files at:

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
```

Each line is a JSON object. The first few lines contain session metadata (`slug`, `gitBranch`, `cwd`, `version`, `timestamp`). Subsequent lines are conversation messages with `"type": "user"` or `"type": "assistant"` entries.

Active sessions are identified by checking the file's mtime against a configurable threshold (default 300 seconds / 5 minutes).

---

## All RecordType Constants

All record type string constants are now defined in a single canonical `StrEnum` named `EntityType` in `flow_sdk/schema/types.py`. `flow_sdk/fs_store/record_types.py` is a backward-compatibility shim: both `RecordType` and `SkillitRecordType` are plain aliases of `EntityType` (same class). New code should import `EntityType` directly. The enum is large (100+ members); the tables below cover the commonly-referenced subset — consult `flow_sdk/schema/types.py` for the authoritative list.

### FlowPad-Owned Records

These record types are owned by flow-cli and stored under `~/.flow/instances/<name>/records/<type>/`.

| Constant | String value | Description |
|----------|-------------|-------------|
| `PROJECT` | `"project"` | Project container |
| `CLAUDE_SESSION` | `"claude_session"` | Claude session entity |
| `TASK` | `"task"` | Task record |
| `RULE` | `"rule"` | Rule record |
| `SKILL` | `"skill"` | Skill record |
| `AGENT` | `"agent"` | Agent entity |
| `LOG` | `"log"` | Log entry |
| `AGENTIC_PROCESS` | `"agentic_process"` | Agentic execution process |
| `ARTIFACT` | `"artifact"` | Artifact record |
| `MARKDOWN` | `"markdown"` | Markdown document record |
| `MARKDOWN_INDEX` | `"markdown_index"` | Markdown folder/index record |
| `COMPUTE_NODE` | `"compute_node"` | Compute node |
| `SESSION_ANALYSIS` | `"session_analysis"` | Analysis results for a session |
| `SESSION_CLASSIFICATION` | `"session_classification"` | Session classification |
| `CLAUDE_ERROR` | `"claude_error"` | Deduplicated, triaged error record |
| `ENVIRONMENT` | `"environment"` | Environment record |
| `SHELL` | `"shell"` | Shell/PTY session |
| `TRIGGER_LOG` | `"trigger_log"` | Trigger execution log |
| `SCAN_LOG` | `"scan_log"` | Schema scan operation log |
| `INDEX_LOG` | `"index_log"` | Schema index operation log |
| `DOC_DB` | `"doc_db"` | Search/index document record |
| `RECORD_ERROR` | `"record_error"` | Error encountered during record operations |
| `TEXT_FILE` | `"text_file"` | Generic text file record |

> **Note — renames**: The old `SESSION = "session"` and `SHELL_SESSION = "shell_session"` constants no longer exist; sessions are now `CLAUDE_SESSION` / `CODEX_SESSION` and shells are `SHELL`. There is no `MEMO` type; note/document content is represented by `MARKDOWN`.

> **Note — Codex types**: `EntityType` also defines `CODEX_SESSION = "codex_session"` and `CODEX_PROJECT = "codex_project"` for Codex CLI data, alongside the Claude equivalents.

> **Note — skillit constants**: `SKILLIT_SESSION = "skillit_session"` and `SKILLIT_CONFIG = "skillit_config"` are members of the same `EntityType` enum (not a separate StrEnum). `SkillitRecordType` is just an alias of `EntityType`.

### Claude Code Records (read-only, mapped from Claude directories)

These types represent data sourced from Claude Code's own files. The records are read-only (`_read_only = True`) and do not own their underlying data.

| Constant | String value | Source path |
|----------|-------------|-------------|
| `CLAUDE_ROOT` | `"claude_root"` | `~/.claude/projects/` (virtual container) |
| `ACCOUNT` | `"account"` | `~/.claude.json` (deprecated, use `CLAUDE_SETTINGS`) |
| `HOOK` | `"hook"` | `settings.json` `hooks.<event>[]` groups |
| `HOOK_ENTRY` | `"hook_entry"` | Individual command within a hook group |
| `CLAUDE_HOOK` | `"claude_hook"` | Individual hook command (writable overlay at `<records_root>/claude_hook/`) |
| `TODO_FILE` | `"todo_file"` | `~/.claude/todos/<session-id>-agent-<session-id>.json` |
| `TODO_ITEM` | `"todo_item"` | Individual item within a todo file |
| `PLAN` | `"plan"` | `~/.claude/plans/<slug>.md` |
| `COMMAND` | `"command"` | `~/.claude/commands/<name>.md` or `.claude/commands/<name>.md` |
| `MCP_SERVER` | `"mcp_server"` | Entry in `mcp.json` or `.mcp.json` |
| `PLUGIN` | `"plugin"` | `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` |
| `CLAUDE_MD` | `"claude_md"` | `CLAUDE.md`, `CLAUDE.local.md`, or `.claude/CLAUDE.md` |
| `HISTORY` | `"history"` | `~/.claude/history.jsonl` (container record) |
| `HISTORY_ENTRY` | `"history_entry"` | Individual entry in `history.jsonl` |
| `ACTIVE_SESSIONS` | `"active_sessions"` | Virtual container — scans `~/.claude/projects/` for recent sessions |
| `ACTIVE_SESSION` | `"active_session"` | Single active session (mtime within 5 minutes) |
| `CLAUDE_DEBUG_LOG` | `"claude_debug_log"` | `~/.claude/debug/<session-uuid>.txt` |

### Transcript Entry Records

These types represent individual lines parsed from session JSONL transcripts.

| Constant | String value | Description |
|----------|-------------|-------------|
| `TRANSCRIPT_ENTRY` | `"transcript_entry"` | Base type for any transcript line |
| `TRANSCRIPT_PROGRESS` | `"transcript_entry:progress"` | Progress/streaming entry |
| `TRANSCRIPT_TOOL_USE` | `"transcript_entry:tool_use"` | Tool invocation |
| `TRANSCRIPT_TOOL_RESULT` | `"transcript_entry:tool_result"` | Tool result |
| `TRANSCRIPT_FILE_SNAPSHOT` | `"transcript_entry:file_snapshot"` | File snapshot within transcript |
| `TRANSCRIPT_QUEUE_OPERATION` | `"transcript_entry:queue_operation"` | Queue operation |
| `TRANSCRIPT_SUMMARY` | `"transcript_entry:summary"` | Compact summary entry |
| `TRANSCRIPT_CUSTOM_TITLE` | `"transcript_entry:custom_title"` | Custom session title |
| `TRANSCRIPT_PR_LINK` | `"transcript_entry:pr_link"` | Pull request link |

### `.claude.json` Settings Records

These types are extracted from `~/.claude.json` by `ClaudeSettingsRecordList`.

| Constant | String value | JSON path in `.claude.json` |
|----------|-------------|----------------------------|
| `CLAUDE_SETTINGS` | `"claude_settings"` | Root (`""`) |
| `CLAUDE_SETTINGS_OAUTH` | `"claude_settings:oauth_account"` | `/oauthAccount` |
| `CLAUDE_SETTINGS_PROJECT` | `"claude_settings:project_entry"` | `/projects/<path>` |
| `CLAUDE_SETTINGS_MODEL_USAGE` | `"claude_settings:model_usage"` | `/projects/<path>/lastModelUsage/<model>` |
| `CLAUDE_SETTINGS_MCP_SERVER` | `"claude_settings:mcp_server_config"` | `/projects/<path>/mcpServers/<name>` |
| `CLAUDE_SETTINGS_FEATURE_FLAGS` | `"claude_settings:feature_flags"` | `/cachedStatsigGates` |
| `CLAUDE_SETTINGS_TIPS_HISTORY` | `"claude_settings:tips_history"` | `/tipsHistory` |
| `CLAUDE_SETTINGS_SKILL_USAGE` | `"claude_settings:skill_usage"` | `/skillUsage/<skill>` |
| `CLAUDE_SETTINGS_GITHUB_REPOS` | `"claude_settings:github_repos"` | `/githubRepoPaths` |

### `settings.json` Records

These types are extracted from `~/.claude/settings.json` (or project-level `.claude/settings.json`) by `ClaudeSettingsJsonRecordList`.

| Constant | String value | JSON path in `settings.json` |
|----------|-------------|------------------------------|
| `CLAUDE_SETTINGS_JSON` | `"claude_settings_json"` | Root (`""`) |
| `CLAUDE_SETTINGS_JSON_PERMISSIONS` | `"claude_settings_json:permissions"` | `/permissions` |
| `CLAUDE_SETTINGS_JSON_SANDBOX` | `"claude_settings_json:sandbox"` | `/sandbox` |
| `CLAUDE_SETTINGS_JSON_ATTRIBUTION` | `"claude_settings_json:attribution"` | `/attribution` |

### Managed Settings Records

| Constant | String value | Source path |
|----------|-------------|-------------|
| `CLAUDE_MANAGED_SETTINGS` | `"claude_managed_settings"` | `~/.claude/managed-settings.json` |

### MCP JSON Records

| Constant | String value | Source path |
|----------|-------------|-------------|
| `CLAUDE_MCP_JSON` | `"claude_mcp_json"` | `~/.claude/mcp.json` or `.mcp.json` or `.claude/mcp.json` |

### CLI Log Records

| Constant | String value | Description |
|----------|-------------|-------------|
| `CLI_LOG` | `"cli_log"` | CLI log entry |
| `CLI_LOG_SETTINGS` | `"cli_log_settings"` | CLI log settings |

---

## How Types Map to Directories (per-type indexer functions)

The old `flow_sdk/fs_records/` per-type record classes (`ClaudeRootFsRecord`, `ClaudeSessionFsRecord`, `SkillRecord`, `AgenticProcess`, …) no longer exist. With `FSRecord` knowing nothing about types, all per-type behavior lives in **free functions registered on `TypeInfo`** and dispatched by the indexer:

- `from_disk_fn(FSRef) -> list[FSRecord]` — parse a source file/dir into records (cold path)
- `gen_uuid_fn(FSRef) -> str` — mint/read the record id (hot path)
- `asset_hash_fn(FSRef) -> float` — cheap freshness stat
- `post_sync_fn`, `default_body_fn`, `meta_model`, `main_subdir`, `main_layout`

These are defined next to their type in `flow_sdk/fs_store/indexer/functions/<type>.py` (e.g. `claude_sessions.py`, `claude_md.py`, `skill.py`, `mcp_server.py`, `plugin.py`, `task.py`, `markdown.py`) and the corresponding `flow_sdk/schema/type_info/<type>_info.py`. The table below maps types to the on-disk location their indexer reads.

| RecordType | Source |
|-----------|--------|
| `CLAUDE_ROOT` | `~/.claude/projects/` (directory listing) |
| `CLAUDE_SESSION` | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` |
| `ACTIVE_SESSIONS` / `ACTIVE_SESSION` | Scans `~/.claude/projects/*/*.jsonl` for recent mtime |
| `HISTORY` / `HISTORY_ENTRY` | `~/.claude/history.jsonl` (container + lines) |
| `CLAUDE_DEBUG_LOG` | `~/.claude/debug/<uuid>.txt` |
| `HOOK` / `HOOK_ENTRY` / `CLAUDE_HOOK` | `hooks.<event>[]` in `settings.json` (writable overlay under `<records_root>/claude_hook/`) |
| `COMMAND` | `~/.claude/commands/<name>.md` or `.claude/commands/<name>.md` |
| `CLAUDE_MD` | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` |
| `PLAN` | `~/.claude/plans/<slug>.md` |
| `TODO_FILE` / `TODO_ITEM` | `~/.claude/todos/<session-id>-agent-<session-id>.json` |
| `PLUGIN` | `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` |
| `MCP_SERVER` | Entries in `mcp.json` / `.mcp.json` / `.claude/mcp.json` |
| `ACCOUNT` | `~/.claude.json` (deprecated) |
| `CLAUDE_ERROR` | Synced from `~/.claude/debug/*.txt` into `<records_root>/claude_error/` |
| `CODEX_SESSION` / `CODEX_PROJECT` | `~/.codex/sessions/` (see `codex_sessions.py` / `codex_projects.py`) |
| `SESSION_ANALYSIS` / `SESSION_CLASSIFICATION` | `<records_root>/<type>/<type>-@<uid>/` |

FlowPad-owned types (`SKILL`, `AGENT`, `AGENTIC_PROCESS`, `TASK`, `MARKDOWN`, …) follow the standard `<records_root>/<type>/<type>-@<uid>/` shadow-folder pattern, with their user-facing asset (if any) at the `main_subdir`-derived `asset_ref`.

> **Claude hook source files**: hook discovery scans multiple settings files, not just `~/.claude/settings.json` — user `settings.json` / `settings.local.json`, project `.claude/settings.json` / `.claude/settings.local.json`, plugin `hooks/hooks.json`, and legacy `~/.claude.json`. See `flow_sdk/fs_store/indexer/functions/claude_hook.py` and `flow_sdk/fs_store/operations/claude_hook.py`.

---

## Source-File Extractors and the Config File Whitelist

### Extractor functions

A "source file" is a known Claude JSON config file that the system splits into multiple typed records. Each extracted record carries a `source_file` (the path to the file) and a `json_path` (an RFC 6901 JSON Pointer indicating its position within that file).

The class-based `SourceFileRecordList` hierarchy and the `SourceFileRegistry` (`flow_sdk/fs_store/source_file_registry.py`) have been **dissolved**. Extraction is now done by pure functions `(data: dict, source_file: str) -> list[dict]` in `flow_sdk/fs_store/source_file_records.py`, keyed by filename in the `_EXTRACTORS` dict:

```python
_EXTRACTORS = {
    "settings.json":         _extract_settings_json,
    "settings.local.json":   _extract_settings_json,
    "managed-settings.json": _extract_managed_settings,
    "mcp.json":              _extract_mcp_json,
    ".mcp.json":             _extract_mcp_json,
}
```

The public surface is `known_filename(path)`, `extract_from_data(data, path)`, and `extract_records(path)`. The path-based API handler `FsRecordsActionsMixin._handle_path_based_source_file` (`flow_sdk/builtin/faas/fs_records_actions.py`) delegates here. Note there is **no** `.claude.json` extractor — that file is not split server-side via this path.

### Allowed Source Filenames Whitelist

The path-based API (`/fs-records/file?path=...`) restricts which files can be accessed via `is_allowed_source_path()`. The allow-list is derived directly from `_EXTRACTORS` so it can't drift:

```python
_ALLOWED_FILENAMES = frozenset(_EXTRACTORS.keys())
# {"settings.json", "settings.local.json", "managed-settings.json",
#  "mcp.json", ".mcp.json"}
```

### `is_allowed_source_path()` Security Check

Having an allowed filename is not sufficient — the path must also sit under a `.claude/` directory or be a project-root `.mcp.json`:

```python
_ALLOWED_PATH_FRAGMENTS = (".claude/", "/.mcp.json")

def is_allowed_source_path(path: str) -> bool:
    expanded = str(Path(path).expanduser())
    if Path(expanded).name not in _ALLOWED_FILENAMES:
        return False
    return any(frag in expanded for frag in _ALLOWED_PATH_FRAGMENTS)
```

The check proceeds in two steps:

1. The filename must be in `_ALLOWED_FILENAMES`.
2. The expanded path must contain one of the `_ALLOWED_PATH_FRAGMENTS` substrings:
   - `.claude/` — any file inside a `.claude/` directory, or
   - `/.mcp.json` — the project-root MCP dot-file.

This prevents the API from opening arbitrary files on disk — only known Claude configuration files are accessible. (It is a plain substring match, not an anchored regex.)

### Registered Filename-to-Extractor Mapping

| Filename | Extractor | Yields | Default path |
|----------|-----------|--------|-------------|
| `settings.json` | `_extract_settings_json` | `CLAUDE_SETTINGS_JSON` + permissions/sandbox/attribution | `~/.claude/settings.json` |
| `settings.local.json` | `_extract_settings_json` | same as above | `~/.claude/settings.local.json` or `.claude/settings.local.json` |
| `mcp.json` | `_extract_mcp_json` | `CLAUDE_MCP_JSON` root + one per-server record | `~/.claude/mcp.json` or `.claude/mcp.json` |
| `.mcp.json` | `_extract_mcp_json` | same as above | `<project-root>/.mcp.json` |
| `managed-settings.json` | `_extract_managed_settings` | single `CLAUDE_MANAGED_SETTINGS` root | `~/.claude/managed-settings.json` |

---

## Complete Annotated Directory Tree

```
$HOME/
  .claude.json                        # Global Claude settings (ClaudeSettingsRecordList)
  .claude/
    settings.json                     # User-level settings (ClaudeSettingsJsonRecordList)
    settings.local.json               # Local user overrides (ClaudeSettingsJsonRecordList)
    managed-settings.json             # IT-managed restrictions (ClaudeManagedSettingsRecordList)
    mcp.json                          # User-level MCP servers (ClaudeMcpJsonRecordList)
    history.jsonl                     # Global prompt history (ClaudeHistoryFsRecord)
    projects/
      <encoded-cwd>/                  # One dir per working directory
        <session-uuid>.jsonl          # Session transcript (ClaudeSessionFsRecord)
    commands/
      <name>.md                       # User slash command (ClaudeCommandFsRecord)
    plans/
      <slug>.md                       # Saved plan (ClaudePlanFsRecord)
    todos/
      <sid>-agent-<sid>.json          # Todo list (ClaudeTodoFsRecord)
    debug/
      <session-uuid>.txt              # Debug log (ClaudeDebugLogFsRecord)
    plugins/
      installed_plugins.json          # Plugin registry
      cache/
        <marketplace>/
          <plugin>/
            <version-hash>/           # Plugin cache (ClaudePluginFsRecord)

  .flow/
    global/                             # cross-instance shared state
      migrations/                       # per-version migration status JSON
    instances/
      <name>/                           # per-instance root (prod | dev | test | oss | ...)
        flowpad.db                      # SQLite entity DB (lives directly here)
        server.json  server.pid  server.lock   # running-server coordination
        config.json  preferences.json   # instance config
        sodot  .secrets_enabled          # encrypted secrets + consent marker
        logs/                            # per-instance logs
        schema/                          # SchemaRegistry logs and type info
          scan_log.jsonl                # scan log
          types/
            <type>/
              type_info.json            # per-type TypeInfo
              scan_log.jsonl            # per-type scan log
              index_log.jsonl           # per-type index log
        records/                         # owned record shadow folders
          task/
            task-@<uid>/
              metadata.json             # ALL persisted fields (flat)
              <epoch>_<hexdigest>.hash  # index sentinel (zero-byte)
          skill/
            skill-@<uid>/
              metadata.json
              <epoch>_<hexdigest>.hash
          claude_error/
            claude_error-@<fingerprint>/
              metadata.json
          claude_hook/
            claude_hook-@<content-hash>/
              metadata.json             # writable hook overlay
          agentic_process/
            agentic_process-@<uid>/
              metadata.json
          # ... other types follow the same metadata.json + .hash pattern ...
        records_data/                    # user-facing asset content (asset_ref targets)
          conversation/  markdown_index/  shell/   # per-type asset dirs/files
        tasks/  skill_rules/              # other per-instance working dirs
```

> Note: the shadow folder under `records/<type>/` holds only `metadata.json` and the `.hash` sentinel. There is no `_data.json`, `state.json`, `output/`, or `analysis.json` companion. A type's user-facing content lives at its `asset_ref` — either under `records_data/<type>/` or under the user's project scope at `<scope_root>/<main_subdir>/...` (e.g. `skill` → `.claude/skills/<name>/`).

Project-level Claude configuration (placed in the working directory, not the home directory):

```
<project-root>/
  .mcp.json                           # Project-level MCP servers (ClaudeMcpJsonRecordList)
  CLAUDE.md                           # Project instructions (ClaudeMdFsRecord)
  CLAUDE.local.md                     # Local project instructions (ClaudeMdFsRecord)
  .claude/
    settings.json                     # Project settings (ClaudeSettingsJsonRecordList)
    settings.local.json               # Project local settings (ClaudeSettingsJsonRecordList)
    mcp.json                          # Project MCP servers (ClaudeMcpJsonRecordList)
    CLAUDE.md                         # Project instructions in .claude/ (ClaudeMdFsRecord)
    commands/
      <name>.md                       # Project slash command (ClaudeCommandFsRecord)
```
