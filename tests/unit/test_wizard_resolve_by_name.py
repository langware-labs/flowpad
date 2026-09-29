"""A step's callee is resolved by NAME, and a name can be shared.

A second Flowpad checkout registered as a project carries its own copy of every
shipped wizard and op; on another branch one may hold a different id, so two rows
share one name. That used to raise out of the run ("Multiple (2) existing
entities ... 'llm-setup-node'") and 500 the first-run setup. The callee a shipped
wizard means is the one shipped with THIS install; anything still ambiguous is
"not found", never a crash.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from flow_sdk.core.wizard import execute


@dataclass
class _Row:
    asset_ref: str


def _entity(rows):
    class _Entity:
        @staticmethod
        def get_type():
            return "wizard"

        @staticmethod
        async def get_all(_query):
            return list(rows)

    return _Entity


@pytest.fixture
def shipped(tmp_path, monkeypatch):
    """This install's system_projects root, and a path inside it."""
    root = tmp_path / "site-packages" / "flow_sdk" / "system_projects"
    monkeypatch.setattr("flow_sdk.config.system_projects_root", lambda: root)
    return root / "flowpad_assistant" / "agentic-assets" / "wizard" / "llm-setup-node"


def _other_checkout(tmp_path):
    return tmp_path / "flowpad-open-source-deploy" / "flow_sdk" / "system_projects" / "wizard" / "llm-setup-node"


async def test_a_single_row_is_the_callee(shipped):
    row = _Row(str(shipped))

    assert await execute._by_name(_entity([row]), "llm-setup-node") is row


async def test_this_installs_copy_wins_over_another_checkouts(shipped, tmp_path):
    ours, theirs = _Row(str(shipped)), _Row(str(_other_checkout(tmp_path)))

    assert await execute._by_name(_entity([theirs, ours]), "llm-setup-node") is ours


async def test_still_ambiguous_is_not_found_rather_than_a_crash(shipped, tmp_path):
    a = _Row(str(_other_checkout(tmp_path)))
    b = _Row(str(tmp_path / "another-clone" / "llm-setup-node"))

    assert await execute._by_name(_entity([a, b]), "llm-setup-node") is None


async def test_no_row_is_not_found(shipped):
    assert await execute._by_name(_entity([]), "llm-setup-node") is None
