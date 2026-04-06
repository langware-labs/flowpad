"""Tests for the path-based fs-records API (source_file_registry + compute_node handler)."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.fs_store import RecordType
from flow_sdk.fs_store.source_file_registry import (
    register_file_pattern,
    resolve_list_class,
    is_allowed_source_path,
    _FILE_PATTERNS,
)
from flow_sdk.fs_records.claude.claude_settings_json import (
    ClaudeSettingsJsonRecordList,
    ClaudeSettingsJsonFsRecord,
    ClaudePermissionsFsRecord,
)
from flow_sdk.fs_records.claude.claude_mcp_json import ClaudeMcpJsonRecordList
from flow_sdk.fs_records.claude.claude_managed_settings import (
    ClaudeManagedSettingsFsRecord,
    ClaudeManagedSettingsRecordList,
)


# ---------------------------------------------------------------------------
# Sample data
# ---------------------------------------------------------------------------

SAMPLE_SETTINGS = {
    "model": "claude-sonnet-4-6",
    "env": {"MY_VAR": "value"},
    "permissions": {
        "allow": ["Read", "Glob"],
        "deny": [],
    },
    "sandbox": {
        "enabled": True,
        "network": {"allowedDomains": ["api.example.com"]},
    },
}

SAMPLE_MCP_JSON = {
    "mcpServers": {
        "test-server": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "test-mcp"],
        },
    },
}


# ---------------------------------------------------------------------------
# File-pattern registry tests
# ---------------------------------------------------------------------------


class TestResolveListClass:
    def test_resolve_settings_json(self):
        """settings.json resolves to ClaudeSettingsJsonRecordList."""
        cls = resolve_list_class("/Users/me/.claude/settings.json")
        assert cls is ClaudeSettingsJsonRecordList

    def test_resolve_settings_local_json(self):
        """settings.local.json resolves to ClaudeSettingsJsonRecordList."""
        cls = resolve_list_class("/project/.claude/settings.local.json")
        assert cls is ClaudeSettingsJsonRecordList

    def test_resolve_mcp_json(self):
        """mcp.json resolves to ClaudeMcpJsonRecordList."""
        cls = resolve_list_class("/Users/me/.claude/mcp.json")
        assert cls is ClaudeMcpJsonRecordList

    def test_resolve_dot_mcp_json(self):
        """.mcp.json resolves to ClaudeMcpJsonRecordList."""
        cls = resolve_list_class("/project/.mcp.json")
        assert cls is ClaudeMcpJsonRecordList

    def test_resolve_managed_settings(self):
        """managed-settings.json resolves to ClaudeManagedSettingsRecordList."""
        cls = resolve_list_class("/Users/me/.claude/managed-settings.json")
        assert cls is ClaudeManagedSettingsRecordList

    def test_resolve_unknown(self):
        """Unknown filenames return None."""
        cls = resolve_list_class("/etc/passwd")
        assert cls is None

    def test_resolve_unregistered(self):
        """A filename not in the registry returns None."""
        cls = resolve_list_class("/some/path/unknown.json")
        assert cls is None


# ---------------------------------------------------------------------------
# Security allowlist tests
# ---------------------------------------------------------------------------


class TestIsAllowedSourcePath:
    def test_allowed_user_settings(self):
        assert is_allowed_source_path("~/.claude/settings.json") is True

    def test_allowed_user_settings_expanded(self):
        home = str(Path.home())
        assert is_allowed_source_path(f"{home}/.claude/settings.json") is True

    def test_allowed_project_settings(self):
        assert is_allowed_source_path("/my/project/.claude/settings.json") is True

    def test_allowed_project_local(self):
        assert is_allowed_source_path("/my/project/.claude/settings.local.json") is True

    def test_allowed_project_mcp(self):
        assert is_allowed_source_path("/my/project/.mcp.json") is True

    def test_allowed_user_mcp(self):
        assert is_allowed_source_path("~/.claude/mcp.json") is True

    def test_allowed_managed_settings(self):
        assert is_allowed_source_path("~/.claude/managed-settings.json") is True

    def test_allowed_claude_json(self):
        assert is_allowed_source_path("~/.claude.json") is True

    def test_disallowed_arbitrary_file(self):
        assert is_allowed_source_path("/etc/passwd") is False

    def test_disallowed_outside_claude(self):
        """settings.json not under .claude/ should be rejected."""
        assert is_allowed_source_path("/home/user/settings.json") is False

    def test_disallowed_arbitrary_json(self):
        assert is_allowed_source_path("/tmp/malicious.json") is False

    def test_disallowed_similar_name(self):
        """A file named settings.json not under .claude/ is disallowed."""
        assert is_allowed_source_path("/var/data/settings.json") is False


# ---------------------------------------------------------------------------
# Path-based handler tests (mock request_info)
# ---------------------------------------------------------------------------


def _make_request_info(method: str, path: str, json_path: str | None = None, body: dict | None = None):
    """Create a mock request_info for the path-based handler."""
    qp = {"path": path}
    if json_path is not None:
        qp["json_path"] = json_path

    request = MagicMock()
    request.query_params = qp

    ri = MagicMock()
    ri.request = request
    ri.method = method
    ri.sub_path = "file"
    ri.get_post_data = AsyncMock(return_value=body)

    return ri


def _make_compute_node():
    """Create a mock that has the path-based handler methods from ComputeNode."""
    from flow_sdk.builtin.faas.compute_node import ComputeNode

    node = MagicMock(spec=ComputeNode)
    # Bind the real methods we want to test
    node._handle_path_based_source_file = ComputeNode._handle_path_based_source_file.__get__(node)
    node._find_record_by_json_path = ComputeNode._find_record_by_json_path
    node._broadcast_fs_record_op = AsyncMock()
    return node


class TestPathBasedHandler:
    def test_path_list_all_records(self, tmp_path):
        """GET without json_path returns all records with source_file and json_path fields."""
        f = tmp_path / ".claude" / "settings.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(SAMPLE_SETTINGS))

        node = _make_compute_node()
        ri = _make_request_info("get", str(f))

        import asyncio
        with patch("flow_sdk.fs_store.source_file_registry.is_allowed_source_path", return_value=True):
            with patch("flow_sdk.fs_store.source_file_registry.resolve_list_class", return_value=ClaudeSettingsJsonRecordList):
                result = asyncio.get_event_loop().run_until_complete(
                    node._handle_path_based_source_file("get", ri)
                )

        assert result.status == "SUCCESS"
        data = result.data
        assert isinstance(data, list)
        assert len(data) >= 3  # root + permissions + sandbox (at least)
        for item in data:
            assert "source_file" in item
            assert "json_path" in item
            assert item["source_file"] == str(f)

    def test_path_get_by_json_path(self, tmp_path):
        """GET with json_path=/permissions returns one record."""
        f = tmp_path / ".claude" / "settings.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(SAMPLE_SETTINGS))

        node = _make_compute_node()
        ri = _make_request_info("get", str(f), json_path="/permissions")

        import asyncio
        with patch("flow_sdk.fs_store.source_file_registry.is_allowed_source_path", return_value=True):
            with patch("flow_sdk.fs_store.source_file_registry.resolve_list_class", return_value=ClaudeSettingsJsonRecordList):
                result = asyncio.get_event_loop().run_until_complete(
                    node._handle_path_based_source_file("get", ri)
                )

        assert result.status == "SUCCESS"
        assert result.data["type"] == RecordType.CLAUDE_SETTINGS_JSON_PERMISSIONS
        assert result.data["json_path"] == "/permissions"

    def test_path_get_root_record(self, tmp_path):
        """GET with json_path= (empty) returns root record."""
        f = tmp_path / ".claude" / "settings.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(SAMPLE_SETTINGS))

        node = _make_compute_node()
        ri = _make_request_info("get", str(f), json_path="")

        import asyncio
        with patch("flow_sdk.fs_store.source_file_registry.is_allowed_source_path", return_value=True):
            with patch("flow_sdk.fs_store.source_file_registry.resolve_list_class", return_value=ClaudeSettingsJsonRecordList):
                result = asyncio.get_event_loop().run_until_complete(
                    node._handle_path_based_source_file("get", ri)
                )

        assert result.status == "SUCCESS"
        assert result.data["type"] == RecordType.CLAUDE_SETTINGS_JSON

    def test_path_update_record(self, tmp_path):
        """PUT updates fields and writes back to file."""
        f = tmp_path / ".claude" / "settings.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(SAMPLE_SETTINGS))

        node = _make_compute_node()
        body = {"allow": ["Read", "Glob", "Bash"]}
        ri = _make_request_info("put", str(f), json_path="/permissions", body=body)

        import asyncio
        with patch("flow_sdk.fs_store.source_file_registry.is_allowed_source_path", return_value=True):
            with patch("flow_sdk.fs_store.source_file_registry.resolve_list_class", return_value=ClaudeSettingsJsonRecordList):
                with patch.object(node, "_broadcast_fs_record_op", new_callable=AsyncMock):
                    result = asyncio.get_event_loop().run_until_complete(
                        node._handle_path_based_source_file("put", ri)
                    )

        assert result.status == "SUCCESS"
        assert result.data["source_file"] == str(f)

    def test_path_update_roundtrip(self, tmp_path):
        """PUT → re-read file → verify JSON changed."""
        f = tmp_path / ".claude" / "settings.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(SAMPLE_SETTINGS))

        node = _make_compute_node()
        body = {"allow": ["Read", "Glob", "Bash", "Edit"]}
        ri = _make_request_info("put", str(f), json_path="/permissions", body=body)

        import asyncio
        with patch("flow_sdk.fs_store.source_file_registry.is_allowed_source_path", return_value=True):
            with patch("flow_sdk.fs_store.source_file_registry.resolve_list_class", return_value=ClaudeSettingsJsonRecordList):
                with patch.object(node, "_broadcast_fs_record_op", new_callable=AsyncMock):
                    asyncio.get_event_loop().run_until_complete(
                        node._handle_path_based_source_file("put", ri)
                    )

        raw = json.loads(f.read_text())
        assert raw["permissions"]["allow"] == ["Read", "Glob", "Bash", "Edit"]
        # model should still be there
        assert raw["model"] == "claude-sonnet-4-6"

    def test_path_delete_record(self, tmp_path):
        """DELETE removes sub-record from file."""
        f = tmp_path / ".claude" / "settings.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(SAMPLE_SETTINGS))

        node = _make_compute_node()
        ri = _make_request_info("delete", str(f), json_path="/permissions")

        import asyncio
        with patch("flow_sdk.fs_store.source_file_registry.is_allowed_source_path", return_value=True):
            with patch("flow_sdk.fs_store.source_file_registry.resolve_list_class", return_value=ClaudeSettingsJsonRecordList):
                with patch.object(node, "_broadcast_fs_record_op", new_callable=AsyncMock):
                    result = asyncio.get_event_loop().run_until_complete(
                        node._handle_path_based_source_file("delete", ri)
                    )

        assert result.status == "SUCCESS"
        raw = json.loads(f.read_text())
        assert "permissions" not in raw
        assert raw["model"] == "claude-sonnet-4-6"

    def test_path_disallowed_returns_403(self, tmp_path):
        """Blocked paths return 403."""
        node = _make_compute_node()
        ri = _make_request_info("get", "/etc/passwd")

        import asyncio
        result = asyncio.get_event_loop().run_until_complete(
            node._handle_path_based_source_file("get", ri)
        )

        assert result.status == "FAIL"
        assert result.status_code == 403

    def test_path_unknown_filename_returns_400(self, tmp_path):
        """Unregistered filenames return 400."""
        node = _make_compute_node()
        ri = _make_request_info("get", "/some/path/.claude/unknown-file.json")

        import asyncio
        # It passes the allowlist check (under .claude/) but the filename is unknown
        with patch("flow_sdk.fs_store.source_file_registry.is_allowed_source_path", return_value=True):
            result = asyncio.get_event_loop().run_until_complete(
                node._handle_path_based_source_file("get", ri)
            )

        assert result.status == "FAIL"
        assert result.status_code == 400

    def test_path_missing_path_param_returns_400(self):
        """Missing 'path' param returns 400."""
        node = _make_compute_node()
        ri = _make_request_info("get", "")

        import asyncio
        result = asyncio.get_event_loop().run_until_complete(
            node._handle_path_based_source_file("get", ri)
        )

        assert result.status == "FAIL"
        assert result.status_code == 400

    def test_path_nonexistent_json_path_returns_404(self, tmp_path):
        """Bad json_path returns 404."""
        f = tmp_path / ".claude" / "settings.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"model": "test"}))

        node = _make_compute_node()
        ri = _make_request_info("get", str(f), json_path="/nonexistent")

        import asyncio
        with patch("flow_sdk.fs_store.source_file_registry.is_allowed_source_path", return_value=True):
            with patch("flow_sdk.fs_store.source_file_registry.resolve_list_class", return_value=ClaudeSettingsJsonRecordList):
                result = asyncio.get_event_loop().run_until_complete(
                    node._handle_path_based_source_file("get", ri)
                )

        assert result.status == "FAIL"
        assert result.status_code == 404

    def test_path_read_only_record_returns_403(self, tmp_path):
        """PUT on read-only record returns 403."""
        f = tmp_path / ".claude" / "managed-settings.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"allowManagedMcpServersOnly": True}))

        node = _make_compute_node()
        body = {"allowManagedMcpServersOnly": False}
        ri = _make_request_info("put", str(f), json_path="", body=body)

        import asyncio
        with patch("flow_sdk.fs_store.source_file_registry.is_allowed_source_path", return_value=True):
            with patch("flow_sdk.fs_store.source_file_registry.resolve_list_class", return_value=ClaudeManagedSettingsRecordList):
                result = asyncio.get_event_loop().run_until_complete(
                    node._handle_path_based_source_file("put", ri)
                )

        assert result.status == "FAIL"
        assert result.status_code == 403

    def test_path_broadcast_includes_source_file(self, tmp_path):
        """DataOp message includes _source_file."""
        f = tmp_path / ".claude" / "settings.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(SAMPLE_SETTINGS))

        node = _make_compute_node()
        body = {"allow": ["Read"]}
        ri = _make_request_info("put", str(f), json_path="/permissions", body=body)

        broadcast_mock = AsyncMock()
        node._broadcast_fs_record_op = broadcast_mock

        import asyncio
        with patch("flow_sdk.fs_store.source_file_registry.is_allowed_source_path", return_value=True):
            with patch("flow_sdk.fs_store.source_file_registry.resolve_list_class", return_value=ClaudeSettingsJsonRecordList):
                asyncio.get_event_loop().run_until_complete(
                    node._handle_path_based_source_file("put", ri)
                )

        broadcast_mock.assert_called_once()
        call_kwargs = broadcast_mock.call_args
        assert call_kwargs.kwargs.get("source_file") == str(f)
