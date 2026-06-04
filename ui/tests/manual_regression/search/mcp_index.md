---
id: c2c94484-47d5-4dd5-853d-7c1e8161a7ed
---

# MCP server indexing — all agents, all scopes (read-only scan)

Regression runbook for the `mcp_server` asset pipeline: the two-stage FSIndexer
walk (`mcp_source_files_fn` → `mcp_servers_in_file_fn` →
`extract_mcp_server` in `flow_sdk/fs_store/indexer/functions/mcp_server.py`).
Verifies that every MCP server definition on the machine is discovered,
indexed with its full *definition-site handle*, browsable, and searchable —
across **all agents** (Claude JSON + Codex TOML) and **all scopes**.

## What must be covered

| Scope | Source | Pointer shape |
| --- | --- | --- |
| user | `~/.claude.json` top-level `mcpServers`, `~/.claude/mcp.json` | `/mcpServers/<name>` |
| user (Codex) | `~/.codex/config.toml` `[mcp_servers.<name>]` (TOML) | `/mcp_servers/<name>` |
| local | `~/.claude.json` → `projects["<cwd>"].mcpServers` (default `claude mcp add`) | `/projects/<esc cwd>/mcpServers/<name>` |
| project | `<proj>/.mcp.json`, `mcp.json`, `.claude/mcp.json` | `/mcpServers/<name>` |

Every record must persist: `name`, `scope` (`user`/`project`/`local`),
`source_file`, `json_path`, `format` (`json`/`toml`), `project_path` (local
only), `command`/`args`/`env` or `url`+`transport`, and a `description`
carrying the launch line (this feeds FTS — search-by-command depends on it).

## Preconditions

1. Backend + UI dev server running (see `run_test_instructions.md`).
2. The machine has at least one server in each scope class. If not, add
   throwaway fixtures (and remove them in cleanup):
   - user: a `demo-user` entry under `mcpServers` in `~/.claude/mcp.json`
   - local: a `demo-local` entry under `projects["/tmp/demo-proj"].mcpServers`
     in `~/.claude.json`
   - codex: `[mcp_servers.demo-codex]` with `command`/`args` in
     `~/.codex/config.toml`
   - project: a `demo-proj` entry in `<known project>/.mcp.json`
3. **Known-projects caveat:** project-scope files are discovered only for
   projects flowpad knows (Claude/Codex sessions or Flowpad projects). A
   `.mcp.json` in a never-visited folder is out of scope **by design** — use a
   known project for the fixture.

test 1: Manual FS sweep matches the index (parity check)
- [cli] enumerate ground truth by hand: every `mcpServers` entry in `~/.claude.json` (top-level AND nested under `projects[*]`), `~/.claude/mcp.json`, each known project's `.mcp.json`/`mcp.json`/`.claude/mcp.json`, plus `[mcp_servers.*]` in `~/.codex/config.toml`
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=mcp_server&force=true
- [api] validate response status "SUCCESS" and `data.errors == 0`
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/mcp_server
- [api] validate the record count equals the manual sweep count (excluding never-visited projects per the caveat above)
- [api] validate every row has non-empty `json_path`, `source_file`, `format`, `scope` — zero rows missing handle fields

test 2: All scope classes present with correct labels
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/mcp_server
- [api] validate at least one row per scope in {user, local, project} (and one with `format == "toml"` when Codex is configured)
- [api] validate a local-scope row has `json_path` starting `/projects/` and a non-empty decoded `project_path`
- [api] validate a Codex row has `source_file` ending `.codex/config.toml` and `json_path` `/mcp_servers/<name>`
- [api] validate a remote server (if any `type: "http"`/`url:` entry exists) has `url` set, `transport == "http"`, and `description == url`

test 3: Records Scanner UI — index + browse
- [browser] navigate to {APP_URL}/dock/lens/fs-records/scan/
- [browser] click the "All" scope chip
- [browser] click "Fast" (or "Full") and wait for the progress banner to finish — expect `mcp_server N/N` and `mcp_server_source M/M` with no errors
- [browser] expand the `mcp_server` row
- [browser] validate the uid column shows all three id shapes:
  - legacy top-level: `<path>/mcp.json:<name>`
  - nested local: `<path>/.claude.json:/projects/~1…/mcpServers/<name>`
  - codex: `<path>/.codex/config.toml:<name>`

test 4: Search UI — by name and by command (FTS via description)
- [browser] type a known server name (e.g. `playwright`) into "Search records…"
- [browser] validate `mcp_server` results appear with the launch line as the row description (e.g. `npx @playwright/mcp@latest`)
- [browser] clear, then type a command substring that is NOT any server's name (e.g. a package name from a server's args)
- [browser] validate the matching `mcp_server` rows still appear — proves search-by-command, not just by name

test 5: Settings-API per-server fragments (regression)
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/file?path=<a project .mcp.json with servers>
- [api] validate the response contains one `claude_mcp_json` root row plus one `claude_mcp_json:entry` row per server (each with `name` + `json_path`) — previously crashed with AttributeError on a non-existent `CLAUDE_MCP_SERVER` enum member

## Learnings / gotchas

- **After an extractor upgrade, plain reindex is not enough.** Skip-fresh
  keys on file mtime, so unchanged config files keep their old-shaped DB rows
  — even with `rebuild=true`. Use `force=true` for a hard refresh.
- The scanner UI's per-type "Records" column reflects the scoped live scan
  (user + current project), not the full DB row count — expand the row or use
  the `fs-records/mcp_server` API for the authoritative list.
- Same-named servers in different scopes/projects are intentionally distinct
  records (different precedence); dedup is a UI concern, not an index one.
- Phase 1 is read-only: records carry the update/remove handle
  (`source_file` + `json_path` + `format`), but no mutation surface exists yet
  (Codex TOML writing needs tomlkit; `.claude.json` is not in the settings-API
  allow-list).

## Cleanup

Remove any fixture entries added in Preconditions and re-run
`POST /fs-records/index?type=mcp_server&force=true` so orphan rows are reaped.
