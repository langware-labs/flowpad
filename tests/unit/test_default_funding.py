"""The set-up verdict (``DefaultFundingSpec``): is the harness a person is about to run funded.

Decided once, on the funding record, so `flow llm set auto`, the chooser, the startup gate, the
warnings and readiness all read the same answer instead of each re-deriving it.
"""
from __future__ import annotations

import pytest

import flow_sdk.core.status as status_mod
from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import _default_funding
from flow_sdk.schema.data_spec.llm_source_spec import LLMSource

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

CLAUDE, CODEX = "harness.claude.cli", "harness.codex.cli"


def _source(typeid: str) -> LLMSource:
    return LLMSource(endpoint_typeid=typeid, name=typeid)


@pytest.fixture
def box(monkeypatch):
    """Claude is the default; ``installed`` says which CLIs are on the box."""
    installed: set[str] = set()

    async def default_harness_kind():
        return CLAUDE

    monkeypatch.setattr(status_mod, "default_harness_kind", default_harness_kind)
    monkeypatch.setattr(status_mod, "is_installed", lambda worker: worker in installed)
    return installed


async def test_an_installed_default_is_set_up_only_by_its_own_source(box):
    """A funded Codex does not make a box whose installed, signed-out Claude is the default ready:
    answering so would skip the sign-in the person needs."""
    box.add("claude")

    verdict = await _default_funding(
        {CLAUDE: None, CODEX: _source("llm_endpoint:key")}, {CLAUDE: "claude is signed out"}
    )

    assert (verdict.installed, verdict.source, verdict.reason) == (True, None, "claude is signed out")


async def test_an_installed_default_names_its_source(box):
    box.add("claude")

    verdict = await _default_funding({CLAUDE: _source("llm_endpoint:dev")}, {})

    assert verdict.source.endpoint_typeid == "llm_endpoint:dev"


async def test_a_default_not_installed_accepts_any_funded_harness(box):
    """Nothing can fund a CLI that is not on the box, so insisting on it would hold first-run setup
    in the chooser forever -- it settles funding BEFORE it installs the default."""
    verdict = await _default_funding({CLAUDE: None, CODEX: _source("llm_endpoint:key")}, {})

    assert verdict.installed is False and verdict.source.endpoint_typeid == "llm_endpoint:key"


async def test_nothing_funded_says_why(box):
    verdict = await _default_funding({CLAUDE: None}, {})

    assert verdict.source is None and "not installed" in verdict.reason
