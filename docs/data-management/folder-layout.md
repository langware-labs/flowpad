---
id: 4c405bbb-553d-5d0f-a818-74ba7df07133
---

# On-Disk Folder Layout

This document describes the complete on-disk structure used by flow-cli: the FlowPad records root (`~/.flow/records/`), the Claude Code directories (`~/.claude/`), all `RecordType` constants, and the `SourceFileRegistry` security check.

## FlowPad Records Root

### Default Root

All owned (writable) FlowPad records live under:

```
~/.flow/records/
```

This path is defined in `flow_sdk/fs_store/record.py`:

```python
_DEFAULT_RECORDS_ROOT: Path = Path.home() / ".flow" / "records"
```

It can be overridden for testing via `set_default_records_root(path)`. The corresponding getter is `get_default_records_root()` — both are exported from `flow_sdk/fs_store/record.py`.

### Folder Naming Convention

Each record occupies its own subdirectory. The directory name follows the pattern:

```
<type>-@<uid>
```

Examples: `task-@abc123`, `session_analysis-@df9e12c4`, `claude_error-@a3b7f91c2e1d`.

The separator is `-@` (defined as `_NAME_SEP` in `record.py`). The `record_stem()` function builds this name and `parse_record_stem()` splits it back apart.

Records are organized by type under the root:

```
~/.flow/records/
  <type>/
    <type>-@<uid>/
      metadata.json         # identity fields: id, type, name
      _data.json            # domain fields: status, prompt, etc.
      state.json            # per-record index cache (RecordState)
      output/               # optional generated output
      analysis.json         # optional companion file (e.g. SessionAnalysis)
      analysis.md           # optional companion file
```

The `default_path` property on `Record` computes:

```python
get_default_records_root() / self.type / record_stem(self.type, self.uid)
```

### Record Data Files (Split Format)

Record data is split across two files in the record folder:

```
<type>-@<uid>/metadata.json     # identity: id, type, name
<type>-@<uid>/_data.json        # domain: status, prompt, description, etc.
```

Both use the wrapped `{"data": {...}}` format. The constants in `record.py`:

```python
_META_JSON = "metadata.json"
_DOMAIN_DATA_JSON = "_data.json"
_META_FIELDS: frozenset[str] = frozenset({"id", "type", "name"})
```

`_data.json` is only written if there are domain fields to persist.

A third file, `state.json`, is managed by `RecordState` and synced on every `save()` call.

See [record-model.md](record-model.md#on-disk-split-format) for full details on the split format, migration, and heal-on-read.

### Backward-Compatible Migration

Two legacy formats are supported with lazy migration on first read:

1. **Oldest format**: `.flow_record/record.json` — migrated to `data.json` via `_migrate_old_format()`.
2. **Combined format**: `data.json` (all fields in one file) — migrated to `metadata.json` + `_data.json` via `_migrate_data_to_split_format()`.

All discovery methods (`Record.discover()`, `Record.discover_one()`, `Record.load()`, `Record.init_record()`) trigger migration transparently.

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

The constant `_DEFAULT_PROJECTS_DIR` (in `claude_root.py`) is:

```python
_DEFAULT_PROJECTS_DIR = Path.home() / ".claude" / "projects"
```

Each subdirectory under `projects/` corresponds to a working directory. The directory name is the absolute filesystem path with `/` replaced by `-`. The leading `/` is stripped and the remainder is prefixed with `-`:

- Working directory `/home/alice/myproject` → `~/.claude/projects/-home-alice-myproject/`
- Working directory `/Users/shlom/Documents/dev/flow-cli` → `~/.claude/projects/-Users-shlom-Documents-dev-flow-cli/`

`ClaudeRootFsRecord.projects` reverses this encoding:

```python
real = "/" + encoded.lstrip("-").replace("-", "/")
```

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

All record type string constants are defined in `flow_sdk/fs_store/record_types.py` as a `StrEnum`.

### FlowPad-Owned Records

These record types are owned by flow-cli and stored under `~/.flow/records/<type>/`.

| Constant | String value | Description |
|----------|-------------|-------------|
| `PROJECT` | `"project"` | Project container |
| `SESSION` | `"session"` | Session entity |
| `TASK` | `"task"` | Task record |
| `RULE` | `"rule"` | Rule record |
| `SKILL` | `"skill"` | Skill record |
| `AGENT` | `"agent"` | Agent entity |
| `LOG` | `"log"` | Log entry |
| `AGENTIC_PROCESS` | `"agentic_process"` | Agentic execution process |
| `ARTIFACT` | `"artifact"` | Artifact record |
| `MEMO` | `"memo"` | Memo record |
| `COMPUTE_NODE` | `"compute_node"` | Compute node |
| `SESSION_ANALYSIS` | `"session_analysis"` | Analysis results for a session |
| `SESSION_CLASSIFICATION` | `"session_classification"` | Session classification |
| `CLAUDE_ERROR` | `"claude_error"` | Deduplicated, triaged error record |
| `ENVIRONMENT` | `"environment"` | Environment record |
| `SHELL_SESSION` | `"shell_session"` | Shell/PTY session |
| `TRIGGER_LOG` | `"trigger_log"` | Trigger execution log |
| `SCAN_LOG` | `"scan_log"` | Schema scan operation log |
| `INDEX_LOG` | `"index_log"` | Schema index operation log |
| `DOC_DB` | `"doc_db"` | Search/index document record |
| `RECORD_ERROR` | `"record_error"` | Error encountered during record operations |
| `TEXT_FILE` | `"text_file"` | Generic text file record |

> **Note — type string reuse**: `PROJECT` (`"project"`) and `SESSION` (`"session"`) are also used by `ClaudeProjectFsRecord` and `ClaudeSessionFsRecord` (read-only Claude Code records). The same type string therefore appears for both FlowPad-owned entities (writable, stored in `~/.flow/records/`) and read-only Claude records. Code filtering by `type == "project"` or `type == "session"` will match both categories.

> **Note — `SkillitRecordType`**: A second StrEnum `SkillitRecordType` is defined in `record_types.py` with two additional constants: `SKILLIT_SESSION = "skillit_session"` and `SKILLIT_CONFIG = "skillit_config"`. These are not FlowPad core record types and are documented separately in the skillit subsystem.

### Claude Code Records (read-only, mapped from Claude directories)

These types represent data sourced from Claude Code's own files. The records are read-only (`_read_only = True`) and do not own their underlying data.

| Constant | String value | Source path |
|----------|-------------|-------------|
| `CLAUDE_ROOT` | `"claude_root"` | `~/.claude/projects/` (virtual container) |
| `ACCOUNT` | `"account"` | `~/.claude.json` (deprecated, use `CLAUDE_SETTINGS`) |
| `HOOK` | `"hook"` | `settings.json` `hooks.<event>[]` groups |
| `HOOK_ENTRY` | `"hook_entry"` | Individual command within a hook group |
| `CLAUDE_HOOK` | `"claude_hook"` | Individual hook command (writable overlay at `~/.flow/records/claude_hook/`) |
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
| `CLAUDE_USAGE` | `"claude_usage"` | API rate-limit/usage (fetched from Anthropic API, not a file) |

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

## How fs_records/ Maps RecordTypes to Directories

The `flow_sdk/fs_records/` package provides concrete record classes for each type. The table below maps each Claude record class to the directory or file it reads from.

| Class | RecordType | Source |
|-------|-----------|--------|
| `ClaudeRootFsRecord` | `CLAUDE_ROOT` | `~/.claude/projects/` (directory listing) |
| `ClaudeProjectFsRecord` | `PROJECT` | `~/.claude/projects/<encoded-cwd>/` (JSONL glob) |
| `ClaudeSessionFsRecord` | `SESSION` | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` |
| `ClaudeActiveSessionsFsRecord` | `ACTIVE_SESSIONS` | Scans `~/.claude/projects/*/*.jsonl` for recent mtime |
| `ClaudeActiveSessionFsRecord` | `ACTIVE_SESSION` | `~/.claude/projects/<project>/<uuid>.jsonl` (mtime check) |
| `ClaudeHistoryFsRecord` | `HISTORY` | `~/.claude/history.jsonl` |
| `ClaudeHistoryEntryFsRecord` | `HISTORY_ENTRY` | Lines within `~/.claude/history.jsonl` |
| `ClaudeDebugLogFsRecord` | `CLAUDE_DEBUG_LOG` | `~/.claude/debug/<uuid>.txt` |
| `ClaudeHookFsRecord` | `HOOK` | `hooks.<event>[]` in `settings.json` |
| `ClaudeHookEntryFsRecord` | `HOOK_ENTRY` | Individual command within a hook group |
| `ClaudeHookRecord` | `CLAUDE_HOOK` | `settings.json` hooks (writable, with metadata overlay at `~/.flow/records/claude_hook/`) |
| `ClaudeCommandFsRecord` | `COMMAND` | `~/.claude/commands/<name>.md` or `.claude/commands/<name>.md` |
| `ClaudeMdFsRecord` | `CLAUDE_MD` | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` |
| `ClaudePlanFsRecord` | `PLAN` | `~/.claude/plans/<slug>.md` |
| `ClaudeTodoFsRecord` | `TODO_FILE` | `~/.claude/todos/<session-id>-agent-<session-id>.json` |
| `ClaudeTodoItemFsRecord` | `TODO_ITEM` | Items within the todo JSON array |
| `ClaudePluginFsRecord` | `PLUGIN` | `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` |
| `ClaudeMcpServerFsRecord` | `MCP_SERVER` | Entries in `mcp.json` / `.mcp.json` / `.claude/mcp.json` |
| `ClaudeAccountFsRecord` | `ACCOUNT` | `~/.claude.json` (deprecated flat record) |
| `ClaudeUsageFsRecord` | `CLAUDE_USAGE` | Anthropic API (`https://api.anthropic.com/api/oauth/usage`) |
| `ClaudeErrorRecord` | `CLAUDE_ERROR` | Synced from `~/.claude/debug/*.txt` into `~/.flow/records/claude_error/` |
| `SessionAnalysis` | `SESSION_ANALYSIS` | `~/.flow/records/session_analysis/<type>-@<uid>/` with companion `analysis.json`/`analysis.md` |

The following FlowPad-owned record classes also exist in `fs_records/` but are not listed above (their layout follows the standard `~/.flow/records/<type>/<type>-@<uid>/` pattern):

| Class | RecordType | Notes |
|-------|-----------|-------|
| `SkillRecord` | `SKILL` | `fs_records/skill_record.py` |
| `AgenticProcess` | `AGENTIC_PROCESS` | `fs_records/agentic_process.py` |
| `SessionClassification` | `SESSION_CLASSIFICATION` | `fs_records/session_classification.py` |
| `AgentRecord` | `AGENT` | `fs_records/agent_record.py` |
| `AgentExecution` | (no dedicated type) | `fs_records/agent_execution.py` |
| `RelationshipRecord` | custom (`"child"`) | `fs_records/relationship.py` — graph edge record |

> **`ClaudeHookRecord` source files**: `ClaudeHookRecordList` scans multiple settings files, not just `~/.claude/settings.json`. The full discovery order is: user `settings.json`, user `settings.local.json`, project `.claude/settings.json`, project `.claude/settings.local.json` (for each active project), plugin `hooks/hooks.json` files, and the legacy `~/.claude.json`.

---

## SourceFileRegistry and the Config File Whitelist

### What is SourceFileRecordList

A `SourceFileRecordList` extracts multiple typed records from a single JSON (or JSONL) file. Each extracted record carries a `source_file` (the path to the file) and a `json_path` (an RFC 6901 JSON Pointer indicating its position within that file).

Examples:
- `ClaudeSettingsRecordList` parses `~/.claude.json` and yields one `CLAUDE_SETTINGS` root record plus sub-records for OAuth, projects, feature flags, etc.
- `ClaudeSettingsJsonRecordList` parses `settings.json` and yields `CLAUDE_SETTINGS_JSON`, `CLAUDE_SETTINGS_JSON_PERMISSIONS`, `CLAUDE_SETTINGS_JSON_SANDBOX`, and `CLAUDE_SETTINGS_JSON_ATTRIBUTION`.
- `ClaudeMcpJsonRecordList` parses `mcp.json` / `.mcp.json` and yields one `MCP_SERVER` record per server.
- `ClaudeManagedSettingsRecordList` parses `managed-settings.json` and yields a single `CLAUDE_MANAGED_SETTINGS` root record.

### SourceFileRegistry

`flow_sdk/fs_store/source_file_registry.py` maintains a global mapping from filename (e.g., `"settings.json"`) to the `SourceFileRecordList` subclass that can parse files with that name.

Registration happens at import time via `register_file_pattern()`:

```python
# In claude_settings_json/__init__.py
register_file_pattern("settings.json", ClaudeSettingsJsonRecordList)
register_file_pattern("settings.local.json", ClaudeSettingsJsonRecordList)

# In claude_settings/__init__.py
register_file_pattern(".claude.json", ClaudeSettingsRecordList)

# In claude_mcp_json.py
register_file_pattern("mcp.json", ClaudeMcpJsonRecordList)
register_file_pattern(".mcp.json", ClaudeMcpJsonRecordList)

# In claude_managed_settings.py
register_file_pattern("managed-settings.json", ClaudeManagedSettingsRecordList)
```

The lookup function `resolve_list_class(source_path)` finds the class by filename only (ignoring the directory):

```python
def resolve_list_class(source_path: str | Path) -> type[SourceFileRecordList] | None:
    return _FILE_PATTERNS.get(Path(source_path).name)
```

### Allowed Source Filenames Whitelist

The path-based API (`/fs-records/file?path=...`) restricts which files can be accessed via `is_allowed_source_path()`. The complete set of allowed filenames is defined as:

```python
_ALLOWED_FILENAMES = frozenset({
    "settings.json",
    "settings.local.json",
    "mcp.json",
    ".mcp.json",
    "managed-settings.json",
    ".claude.json",
})
```

### `is_allowed_source_path()` Security Check

Simply having an allowed filename is not sufficient. The path must also match the pattern that places it under a `.claude/` directory, or be one of the known dot-files (`.mcp.json`, `.claude.json`):

```python
_ALLOWED_PATH_RE = re.compile(
    r"(?:^|/)"
    r"(?:"
    r"\.claude/"
    r"|\.mcp\.json$"
    r"|\.claude\.json$"
    r")"
)

def is_allowed_source_path(path: str) -> bool:
    expanded = str(Path(path).expanduser())
    filename = Path(expanded).name
    if filename not in _ALLOWED_FILENAMES:
        return False
    return bool(_ALLOWED_PATH_RE.search(expanded))
```

The check proceeds in two steps:

1. The filename must be in `_ALLOWED_FILENAMES`.
2. The expanded path must match `_ALLOWED_PATH_RE`, which requires either:
   - The path contains a `/.claude/` directory component (matches `settings.json`, `settings.local.json`, `mcp.json`, `managed-settings.json` placed inside any `.claude/` subdirectory), or
   - The path ends with `/.mcp.json` (project-root dot-file), or
   - The path ends with `/.claude.json` (home directory global settings).

This prevents the API from opening arbitrary files on disk — only known Claude configuration files are accessible.

### Registered Filename-to-Class Mapping

| Filename | RecordList class | Default path |
|----------|-----------------|-------------|
| `settings.json` | `ClaudeSettingsJsonRecordList` | `~/.claude/settings.json` |
| `settings.local.json` | `ClaudeSettingsJsonRecordList` | `~/.claude/settings.local.json` or `.claude/settings.local.json` |
| `mcp.json` | `ClaudeMcpJsonRecordList` | `~/.claude/mcp.json` or `.claude/mcp.json` |
| `.mcp.json` | `ClaudeMcpJsonRecordList` | `<project-root>/.mcp.json` |
| `managed-settings.json` | `ClaudeManagedSettingsRecordList` | `~/.claude/managed-settings.json` |
| `.claude.json` | `ClaudeSettingsRecordList` | `~/.claude.json` |

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
    schema/                             # SchemaRegistry logs and type info
      scan_log.jsonl                    # Global scan log
      index_log.jsonl                   # Global index log
      types/
        <sanitized_type>/
          type_info.json                # Per-type TypeInfo
          scan_log.jsonl                # Per-type scan log
          index_log.jsonl               # Per-type index log
    records/
      task/
        task-@<uid>/
          metadata.json                 # TaskResource identity
          _data.json                    # TaskResource domain data
          state.json                    # RecordState cache
      skill/
        skill-@<uid>/
          metadata.json                 # SkillRecord identity
          _data.json                    # SkillRecord domain data
      session_analysis/
        session_analysis-@<uid>/
          metadata.json                 # SessionAnalysis identity
          _data.json                    # SessionAnalysis domain data
          analysis.json                 # Companion: structured analysis data
          analysis.md                   # Companion: markdown analysis
      claude_error/
        claude_error-@<fingerprint>/
          metadata.json                 # ClaudeErrorRecord (synced from debug/*.txt)
          _data.json
      claude_hook/
        claude_hook-@<content-hash>/
          metadata.json                 # Metadata overlay for a ClaudeHookRecord
          _data.json
      memo/
        memo-@<uid>/
          metadata.json                 # MemoRecord identity
          _data.json                    # MemoRecord domain data
      agentic_process/
        agentic_process-@<uid>/
          metadata.json                 # AgenticProcess identity
          _data.json                    # AgenticProcess domain data
      # ... other types follow the same pattern ...
```

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
