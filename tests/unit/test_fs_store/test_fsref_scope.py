"""Unit tests for FSRef.scope — ambient inheritance through the parent chain.

Rules under test:
  - Explicit scope on a node is returned verbatim.
  - Without an explicit scope, scope is derived by walking up `.parent`.
  - If no ancestor has a scope, the result is None (not a sentinel string).
  - An explicit scope on an intermediate node overrides its ancestors for
    every descendant downstream.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType

# Record types whose legacy walkers attach a scope label (user / project /
# system) to every emitted record. The indexer must be able to propagate
# scope through FSRef so the index stage can set it correctly on each record.
_SCOPE_REQUIRING_TYPES = [
    RecordType.SKILL,
    RecordType.SUBAGENT,
    RecordType.CLAUDE_MD,
    RecordType.CLAUDE_RULES,
    RecordType.COMMAND,
]


def test_explicit_scope_returned(tmp_path: Path) -> None:
    ref = FSRef(tmp_path, scope="user")
    assert ref.scope == "user"


def test_no_parent_no_scope_is_none(tmp_path: Path) -> None:
    ref = FSRef(tmp_path)
    assert ref.scope is None


def test_child_inherits_parent_scope(tmp_path: Path) -> None:
    parent = FSRef(tmp_path, scope="user")
    child = FSRef(tmp_path / "child", parent=parent)
    assert child.scope == "user"


def test_grandchild_inherits_through_chain(tmp_path: Path) -> None:
    root = FSRef(tmp_path, scope="project")
    mid = FSRef(tmp_path / "a", parent=root)
    leaf = FSRef(tmp_path / "a" / "b", parent=mid)
    assert leaf.scope == "project"


def test_explicit_scope_overrides_inheritance(tmp_path: Path) -> None:
    parent = FSRef(tmp_path, scope="user")
    child = FSRef(tmp_path / "child", parent=parent, scope="system")
    assert child.scope == "system"


def test_intermediate_override_flows_down(tmp_path: Path) -> None:
    root = FSRef(tmp_path, scope="user")
    mid = FSRef(tmp_path / "a", parent=root, scope="project")
    leaf = FSRef(tmp_path / "a" / "b", parent=mid)
    assert leaf.scope == "project"


def test_chain_with_no_scope_anywhere_is_none(tmp_path: Path) -> None:
    root = FSRef(tmp_path)
    mid = FSRef(tmp_path / "a", parent=root)
    leaf = FSRef(tmp_path / "a" / "b", parent=mid)
    assert leaf.scope is None


def test_sibling_scopes_are_independent(tmp_path: Path) -> None:
    """Two children of the same parent with different explicit scopes don't cross-contaminate."""
    root = FSRef(tmp_path, scope="user")
    sibling_a = FSRef(tmp_path / "a", parent=root, scope="project")
    sibling_b = FSRef(tmp_path / "b", parent=root)  # inherits
    assert sibling_a.scope == "project"
    assert sibling_b.scope == "user"


@pytest.mark.parametrize("record_type", _SCOPE_REQUIRING_TYPES)
@pytest.mark.parametrize("scope", ["user", "project", "system"])
def test_scope_requiring_type_inherits_from_parent(
    tmp_path: Path, record_type: RecordType, scope: str,
) -> None:
    """Each scope-requiring record type correctly picks up its parent's scope via FSRef.

    Covers the six types whose legacy walkers stamp user/project/system onto
    each record — the indexer relies on FSRef.scope to carry that info
    without per-type plumbing.
    """
    root = FSRef(tmp_path, scope=scope)
    child = FSRef(tmp_path / "item", parent=root, record_type=record_type)
    assert child.scope == scope
    assert child.record_type == record_type
