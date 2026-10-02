"""First-run setup settles the LLM source twice: before its steps, and again after them.

The first settle runs on a bare box, where the default harness is not installed and so can be
funded by nothing — it accepts any funded harness. Once the steps have installed the default,
"set up" means IT is funded, so the source is settled again: that is where a freshly installed,
signed-out Claude gets its sign-in. A box where the default is still missing has nothing new to
fund, and a person who skipped the chooser is not asked twice.
"""
from __future__ import annotations

import pytest

import flow_sdk.core.status as status_mod
from flow_sdk.core.wizard import start as wizard_start
from flow_sdk.schema.data_spec.returned_value_spec import CliResult
from flow_sdk.schema.data_spec.status_spec import InstallState

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

CLAUDE = "harness.claude.cli"


@pytest.fixture
def box(monkeypatch):
    """The default harness, its install state, and what each seam was asked."""
    seen: dict = {"refreshed": [], "settled": 0, "install": InstallState.INSTALLED}

    async def default_harness_kind():
        return CLAUDE

    async def refresh_status(kinds=None):
        seen["refreshed"].append(kinds)

    async def settle():
        seen["settled"] += 1
        return CliResult.satisfied("claude device login funds claude")

    monkeypatch.setattr(status_mod, "default_harness_kind", default_harness_kind)
    monkeypatch.setattr(status_mod, "refresh_status", refresh_status)
    monkeypatch.setattr(status_mod, "harness_install", lambda _worker: seen["install"])
    monkeypatch.setattr(wizard_start, "_resolve_llm_source", settle)
    return seen


async def test_an_installed_default_is_refreshed_and_settled_again(box):
    before = CliResult.satisfied("the hub endpoint funds deepagents")

    after = await wizard_start._settle_after_install(before)

    assert box["refreshed"] == [[CLAUDE]], "only the default harness is re-discovered"
    assert box["settled"] == 1
    assert after.ok and "claude" in after.detail


async def test_a_default_still_missing_keeps_the_first_answer(box):
    box["install"] = InstallState.NOT_INSTALLED
    skipped = CliResult.not_yet("no LLM source was chosen")

    assert await wizard_start._settle_after_install(skipped) is skipped
    assert box["settled"] == 0, "a person who skipped the chooser is not asked twice"
