"""The v5 stable-key TEXT is frozen — entity ids are derived from it.

``TypeInfo.stable_key_for`` derives ``f"{type_name}:{identity_key_fn(ref)}"``
for the types that used to carry a one-line ``*_stable_key`` wrapper. If that
text ever changes, every already-minted v5 id for those types is orphaned, so
the exact strings are pinned here.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.type_info import register_all

register_all()


@pytest.mark.parametrize(
    ("type_name", "path", "expected"),
    [
        (
            "claude_session",
            Path("/home/u/.claude/projects/-home-u-proj/2f1c9e3a-0000-4000-8000-000000000001.jsonl"),
            "claude_session:2f1c9e3a-0000-4000-8000-000000000001",
        ),
        (
            "codex_session",
            Path("/home/u/.codex/sessions/2026/08/30/rollout-2026-08-30T10-00-00-abc123.jsonl"),
            "codex_session:08-30T10-00-00-abc123",
        ),
    ],
)
def test_derived_stable_key_text_is_frozen(type_name, path, expected):
    info = SchemaRegistry.get(type_name)
    assert info.identity_key_fn is not None
    assert info.stable_key_for(path) == expected


def test_derived_key_is_type_prefixed_identity_key():
    """The derivation itself, independent of any one type's key extractor."""
    for type_name in ("claude_session", "codex_session", "copilot_session", "plugin"):
        info = SchemaRegistry.get(type_name)
        assert info.id_stable_key_fn is None, f"{type_name} should derive, not override"
        path = Path("/tmp/whatever/thing.jsonl")
        assert info.stable_key_for(path) == f"{type_name}:{info.identity_key_fn(path)}"
