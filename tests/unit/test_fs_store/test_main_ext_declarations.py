"""A walked file type claims ``.md`` only when its document really is
markdown — a shape's extension is the suffix of the file it reads."""
from __future__ import annotations

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.layout import File
from flow_sdk.schema.type_info import register_all

#: File-layout types whose document really is markdown.
_MARKDOWN_FILE_TYPES = frozenset({
    "markdown", "markdown_index", "claude_md", "claude_memory", "claude_rules",
    "command", "plan", "prompt", "subagent", "claude_plan",
})


@pytest.fixture(scope="module", autouse=True)
def _registry() -> None:
    register_all()


def test_no_walked_file_type_outside_the_markdown_set_claims_md() -> None:
    offenders = [
        info.type_name
        for info in map(SchemaRegistry.get, SchemaRegistry.get_all_types())
        if info.declared   # a declared type, not a probe another test registered
        and isinstance(info.shape, File)
        and info.from_disk_fn is not None
        and info.identity_carrier is not None
        and getattr(info.identity_carrier, "writable", False)   # a derived id is never written into the file
        and info.shape.ext == ".md"
        and info.type_name not in _MARKDOWN_FILE_TYPES
    ]
    assert not offenders, f"file types claiming .md that do not read markdown: {offenders}"
