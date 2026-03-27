"""Tests for ClaudeSessionRecord rename and ClaudeSession DomainObject."""

import pytest

from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
from flow_sdk.fs_records.claude.claude_session import ClaudeSessionFsRecord
from flow_sdk.fs_store.factory.type_registry import type_registry
from flow_sdk.builtin.claude_session import ClaudeSession


class TestClaudeSessionRename:
    def test_new_name_works(self):
        rec = ClaudeSessionRecord(session_id="abc")
        assert rec.id == "abc"

    def test_backward_compat_alias(self):
        assert ClaudeSessionFsRecord is ClaudeSessionRecord

    def test_type_registry_registration(self):
        cls = type_registry.get("claude_session")
        assert cls is ClaudeSessionRecord

    def test_claude_session_domain_fromRecord(self):
        rec = ClaudeSessionRecord(session_id="sess-1", slug="test-session")
        domain = ClaudeSession.fromRecord(rec)
        assert isinstance(domain, ClaudeSession)
        assert domain.worker_session_id == "sess-1"
        assert domain.record is rec

    def test_start_without_shell_raises(self):
        rec = ClaudeSessionRecord(session_id="sess-2")
        session = ClaudeSession(rec)
        with pytest.raises(RuntimeError, match="requires a Shell"):
            session.start("hello")
