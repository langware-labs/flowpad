"""A type's declared document format must be true: ``main_ext`` is the suffix
of the file it actually reads, so a json-document folder type never claims a
sibling ``.md``."""
from __future__ import annotations

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.type_info import register_all

#: File-layout types whose document really is markdown.
_MARKDOWN_FILE_TYPES = frozenset({
    "markdown", "markdown_index", "claude_md", "claude_memory", "claude_rules",
    "command", "plan", "prompt", "subagent", "claude_plan",
})


@pytest.fixture(scope="module", autouse=True)
def _registry() -> None:
    register_all()


def test_folder_types_take_their_format_from_the_main_file() -> None:
    for info in map(SchemaRegistry.get, SchemaRegistry.get_all_types()):
        if info.declared and info.main_layout == "folder" and info.main_file:
            assert info.main_ext == info.main_file.rsplit(".", 1)[-1].join([".", ""]), (
                f"{info.type_name}: main_file={info.main_file} but main_ext={info.main_ext}"
            )


def test_no_walked_file_type_outside_the_markdown_set_claims_md() -> None:
    offenders = [
        info.type_name
        for info in map(SchemaRegistry.get, SchemaRegistry.get_all_types())
        if info.declared   # a declared type, not a probe another test registered
        and info.main_layout == "file"
        and info.from_disk_fn is not None
        and info.identity_carrier is not None
        and getattr(info.identity_carrier, "writable", False)   # a derived id is never written into the file
        and (info.main_ext or "").lower() == ".md"
        and info.type_name not in _MARKDOWN_FILE_TYPES
    ]
    assert not offenders, f"file types claiming .md that do not read markdown: {offenders}"
