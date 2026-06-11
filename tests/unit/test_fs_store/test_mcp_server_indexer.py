"""MCP server indexer — all agents, all scopes (read-only scan).

Covers the two-stage walk (``mcp_source_files_fn`` → ``mcp_servers_in_file_fn``)
and the record extractor over fixture configs:

  - Claude user scope    — top-level ``mcpServers`` in ``~/.claude.json``
  - Claude local scope   — nested ``projects["<cwd>"].mcpServers`` (same file)
  - Claude project scope — ``<proj>/.mcp.json``
  - Codex                — ``~/.codex/config.toml`` ``[mcp_servers.<name>]`` (TOML)

Also asserts the persisted *definition-site handle* (source_file, json_path,
format, scope, project_path) that the later control phase depends on, id
stability/uniqueness, FTS-feeding description, and the ``claude_mcp_json:entry``
regression in the source-file extractor.
"""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.indexer.functions.mcp_server import (
    extract_mcp_server,
    mcp_server_id,
    mcp_servers_in_file_fn,
    mcp_source_files_fn,
)
from flow_sdk.fs_store.record_types import RecordType


PROJ_ALPHA = "/Users/alice/proj-alpha"
PROJ_BETA = "/Users/alice/proj-beta"


def _make_home(tmp_path: Path) -> Path:
    """Fake $HOME: .claude.json (user + 2× local scopes) and .codex/config.toml."""
    home = tmp_path / "home"
    home.mkdir()
    (home / ".claude.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "github": {"command": "npx", "args": ["-y", "@mcp/github"]},
                },
                "projects": {
                    # Same server name in two projects — ids must not collide.
                    PROJ_ALPHA: {
                        "mcpServers": {"db": {"command": "uvx", "args": ["pg-mcp"]}},
                        "history": [],
                    },
                    PROJ_BETA: {
                        "mcpServers": {"db": {"command": "uvx", "args": ["mysql-mcp"]}},
                    },
                },
                "oauthAccount": {"noise": True},
            }
        ),
        encoding="utf-8",
    )
    codex = home / ".codex"
    codex.mkdir()
    (codex / "config.toml").write_text(
        "\n".join(
            [
                "[projects.'/Users/alice/proj-alpha']",
                'trust_level = "trusted"',
                "",
                "[mcp_servers.docs]",
                'command = "npx"',
                'args = ["-y", "docs-mcp"]',
                "",
                "[mcp_servers.docs.env]",
                'API_KEY = "k"',
            ]
        ),
        encoding="utf-8",
    )
    return home


def _make_project(tmp_path: Path) -> Path:
    """Fake project cwd with a .mcp.json holding one stdio + one remote server."""
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / ".mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "linear": {"command": "npx", "args": ["-y", "linear-mcp"]},
                    "sentry": {"type": "http", "url": "https://mcp.sentry.dev/mcp"},
                }
            }
        ),
        encoding="utf-8",
    )
    return proj


def _home_root(home: Path) -> FSRef:
    return FSRef(home, record_type=RecordType.USER_HOME_FOLDER, scope="user")


def _proj_root(proj: Path) -> FSRef:
    return FSRef(proj, record_type=RecordType.CWD_ROOT, scope="project")


def _scan(root: FSRef) -> list[FSRef]:
    """Run both stages over one root, return the per-server FSRefs."""
    opts = IndexerOptions(verbose=False)
    sources = mcp_source_files_fn([root], opts)
    return mcp_servers_in_file_fn(sources, opts)


# ── Stage 1 — source-file enumeration ─────────────────────────────────────────


def test_stage1_finds_claude_json_and_codex_toml_under_home(tmp_path: Path) -> None:
    home = _make_home(tmp_path)
    sources = mcp_source_files_fn([_home_root(home)], IndexerOptions(verbose=False))
    names = sorted(Path(s.path).name for s in sources)
    assert names == [".claude.json", "config.toml"]
    assert all(s.record_type == RecordType.MCP_SERVER_SOURCE for s in sources)


def test_stage1_finds_project_mcp_json(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    sources = mcp_source_files_fn([_proj_root(proj)], IndexerOptions(verbose=False))
    assert [Path(s.path).name for s in sources] == [".mcp.json"]


def test_stage1_dedups_repeated_roots(tmp_path: Path) -> None:
    home = _make_home(tmp_path)
    root = _home_root(home)
    sources = mcp_source_files_fn([root, root], IndexerOptions(verbose=False))
    assert len(sources) == 2  # .claude.json + config.toml, no duplicates


# ── Stage 2 — pointers + scopes ───────────────────────────────────────────────


def test_stage2_emits_all_scopes_from_home(tmp_path: Path) -> None:
    home = _make_home(tmp_path)
    refs = _scan(_home_root(home))
    by_pointer = {r.json_path: r for r in refs}

    assert "/mcpServers/github" in by_pointer  # claude user
    assert "/mcp_servers/docs" in by_pointer  # codex
    local = [p for p in by_pointer if p.startswith("/projects/")]
    assert len(local) == 2  # claude local — one per project

    # Scope: top-level entries inherit the root ("user"); nested are "local".
    assert by_pointer["/mcpServers/github"].scope == "user"
    assert by_pointer["/mcp_servers/docs"].scope == "user"
    assert all(by_pointer[p].scope == "local" for p in local)


def test_stage2_project_scope_inherited(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    refs = _scan(_proj_root(proj))
    assert {r.json_path for r in refs} == {"/mcpServers/linear", "/mcpServers/sentry"}
    assert all(r.scope == "project" for r in refs)


def test_stage2_malformed_files_yield_nothing(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    (home / ".claude.json").write_text("{not json", encoding="utf-8")
    codex = home / ".codex"
    codex.mkdir()
    (codex / "config.toml").write_text("= broken toml [", encoding="utf-8")
    assert _scan(_home_root(home)) == []


# ── Extraction — record payload + definition-site handle ─────────────────────


def _extract_one(refs: list[FSRef], pointer: str):
    (ref,) = [r for r in refs if r.json_path == pointer]
    (rec,) = extract_mcp_server(ref)
    return rec


def test_extract_claude_user_server(tmp_path: Path) -> None:
    home = _make_home(tmp_path)
    rec = _extract_one(_scan(_home_root(home)), "/mcpServers/github")
    d = rec.to_dict()
    assert d["name"] == "github"
    assert d["command"] == "npx"
    assert d["args"] == ["-y", "@mcp/github"]
    assert d["scope"] == "user"
    assert d["transport"] == "stdio"
    assert d["format"] == "json"
    assert d["json_path"] == "/mcpServers/github"
    assert d["source_file"].endswith(".claude.json")
    assert d["project_path"] == ""
    # FTS feeds on description — searchable by command/package.
    assert "npx" in d["description"] and "@mcp/github" in d["description"]
    # Legacy id shape preserved for top-level entries.
    assert d["id"] == f"{d['source_file']}:github"


def test_extract_claude_local_servers_distinct_ids_and_project_path(tmp_path: Path) -> None:
    home = _make_home(tmp_path)
    refs = _scan(_home_root(home))
    local = sorted(
        (extract_mcp_server(r)[0] for r in refs if (r.json_path or "").startswith("/projects/")),
        key=lambda rec: rec.to_dict()["project_path"],
    )
    assert len(local) == 2
    a, b = (rec.to_dict() for rec in local)
    assert {a["name"], b["name"]} == {"db"}  # same name in both projects…
    assert a["id"] != b["id"]  # …but distinct ids
    assert a["project_path"] == PROJ_ALPHA
    assert b["project_path"] == PROJ_BETA
    assert a["scope"] == b["scope"] == "local"
    assert a["json_path"].startswith("/projects/") and "mcpServers/db" in a["json_path"]


def test_extract_codex_toml_server(tmp_path: Path) -> None:
    home = _make_home(tmp_path)
    rec = _extract_one(_scan(_home_root(home)), "/mcp_servers/docs")
    d = rec.to_dict()
    assert d["name"] == "docs"
    assert d["command"] == "npx"
    assert d["args"] == ["-y", "docs-mcp"]
    assert d["env"] == {"API_KEY": "k"}
    assert d["scope"] == "user"
    assert d["format"] == "toml"
    assert d["json_path"] == "/mcp_servers/docs"
    assert d["source_file"].endswith("config.toml")


def test_extract_remote_url_server(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    rec = _extract_one(_scan(_proj_root(proj)), "/mcpServers/sentry")
    d = rec.to_dict()
    assert d["url"] == "https://mcp.sentry.dev/mcp"
    assert d["transport"] == "http"
    assert d["command"] == ""
    assert d["description"] == "https://mcp.sentry.dev/mcp"


def test_gen_id_matches_extracted_record_id(tmp_path: Path) -> None:
    home = _make_home(tmp_path)
    for ref in _scan(_home_root(home)):
        (rec,) = extract_mcp_server(ref)
        assert mcp_server_id(ref) == rec.to_dict()["id"]


def test_extract_vanished_entry_returns_empty(tmp_path: Path) -> None:
    home = _make_home(tmp_path)
    (ref,) = [r for r in _scan(_home_root(home)) if r.json_path == "/mcpServers/github"]
    # Entry removed between scan and parse — extractor must fail soft.
    (home / ".claude.json").write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
    assert extract_mcp_server(ref) == []


# ── All-systems coverage: worker_type / connector_type / cloud connectors ────


def test_resolve_source_maps_each_system(tmp_path: Path) -> None:
    from flow_sdk.flowpad_types.enums.worker_enums import WorkerType
    from flow_sdk.fs_store.indexer.functions.mcp_server import _resolve_source

    cases = [
        (tmp_path / ".vscode" / "mcp.json", "servers", WorkerType.VSCODE),
        (tmp_path / ".cursor" / "mcp.json", "mcpServers", WorkerType.CURSOR),
        (tmp_path / ".codeium" / "windsurf" / "mcp_config.json", "mcpServers", WorkerType.WINDSURF),
        (tmp_path / ".copilot" / "mcp-config.json", "mcpServers", WorkerType.COPILOT),
        (tmp_path / ".codex" / "config.toml", "mcp_servers", WorkerType.CODEX),
        (tmp_path / ".claude.json", "mcpServers", WorkerType.CLAUDE_CODE),
        (
            tmp_path / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json",
            "mcpServers",
            WorkerType.CLAUDE_DESKTOP,
        ),
    ]
    for path, key, worker in cases:
        assert _resolve_source(path) == (key, worker)


def test_vscode_servers_key_parsed(tmp_path: Path) -> None:
    home = tmp_path / "home"
    (home / ".vscode").mkdir(parents=True)
    # VS Code uses the `servers` key; a stray `mcpServers` here must be ignored.
    (home / ".vscode" / "mcp.json").write_text(
        json.dumps(
            {
                "servers": {"foo": {"command": "node", "args": ["s.js"]}},
                "mcpServers": {"ignored": {"command": "nope"}},
            }
        ),
        encoding="utf-8",
    )
    refs = _scan(_home_root(home))
    assert {r.json_path for r in refs} == {"/servers/foo"}
    (rec,) = extract_mcp_server(refs[0])
    d = rec.to_dict()
    assert d["name"] == "foo"
    assert d["worker_type"] == "vscode"
    assert d["connector_type"] == "local"


def test_worker_type_and_connector_type_stamped(tmp_path: Path) -> None:
    home = tmp_path / "home"
    (home / ".cursor").mkdir(parents=True)
    (home / ".cursor" / "mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "local-tool": {"command": "uvx", "args": ["tool"]},
                    "remote-tool": {"type": "http", "url": "https://example.com/mcp"},
                }
            }
        ),
        encoding="utf-8",
    )
    by_name = {
        extract_mcp_server(r)[0].to_dict()["name"]: extract_mcp_server(r)[0].to_dict()
        for r in _scan(_home_root(home))
    }
    assert by_name["local-tool"]["worker_type"] == "cursor"
    assert by_name["local-tool"]["connector_type"] == "local"
    assert by_name["remote-tool"]["worker_type"] == "cursor"
    assert by_name["remote-tool"]["connector_type"] == "remote"


def test_cloud_connector_stubs(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    (home / ".claude.json").write_text(
        json.dumps(
            {
                "claudeAiMcpEverConnected": ["claude.ai Gmail", "Linear"],
                # A real top-level server sharing the cloud name "Linear".
                "mcpServers": {"Linear": {"command": "npx", "args": ["linear-mcp"]}},
            }
        ),
        encoding="utf-8",
    )
    refs = _scan(_home_root(home))
    recs = {r.json_path: extract_mcp_server(r)[0].to_dict() for r in refs}

    gmail = recs["/claudeAiMcpEverConnected/claude.ai Gmail"]
    assert gmail["name"] == "claude.ai Gmail"
    assert gmail["scope"] == "user"
    assert gmail["connector_type"] == "remote"
    assert gmail["worker_type"] == "claude_code"
    assert gmail["command"] == "" and gmail["url"] == ""
    assert gmail["description"]  # non-empty so it stays FTS-searchable

    # The cloud "Linear" stub and the real top-level "Linear" get distinct ids.
    cloud_linear = recs["/claudeAiMcpEverConnected/Linear"]
    real_linear = recs["/mcpServers/Linear"]
    assert cloud_linear["id"] != real_linear["id"]
    assert cloud_linear["connector_type"] == "remote"
    assert real_linear["connector_type"] == "local"


def test_cloud_connector_vanished_returns_empty(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    (home / ".claude.json").write_text(
        json.dumps({"claudeAiMcpEverConnected": ["Sentry"]}), encoding="utf-8"
    )
    (ref,) = _scan(_home_root(home))
    # Connector removed between scan and parse — extractor must fail soft.
    (home / ".claude.json").write_text(
        json.dumps({"claudeAiMcpEverConnected": []}), encoding="utf-8"
    )
    assert extract_mcp_server(ref) == []


# ── Regression — settings-API per-server fragment type ───────────────────────


def test_source_file_extractor_emits_claude_mcp_json_entry(tmp_path: Path) -> None:
    """source_file_records previously referenced a non-existent enum member and
    raised AttributeError on any .mcp.json containing servers."""
    from flow_sdk.fs_store.source_file_records import extract_from_data

    data = {"mcpServers": {"github": {"command": "npx", "args": []}}}
    rows = extract_from_data(data, tmp_path / ".mcp.json")
    types = {r["type"] for r in rows}
    assert RecordType.CLAUDE_MCP_JSON.value in types
    assert "claude_mcp_json:entry" in types
    (entry,) = [r for r in rows if r["type"] == "claude_mcp_json:entry"]
    assert entry["name"] == "github"
    assert entry["json_path"] == "/mcpServers/github"
