"""``docs/snippets/decisions.md``: every Python fence, run as written.

The hub is doubled at its two seams -- ``hub_get`` (the endpoint listing + catalog) and
``hub_invoke_raw`` (the call) -- by the shared double (``tests/utils/decision_double.py``), which
answers in Jev's real wire shape, so the dialect's translation runs for real. The live leg is ``tests/long_tests/test_decision_live.py``.
"""

from __future__ import annotations

import pytest

from tests.utils.decision_double import DECIDER
from tests.utils.harness_installed import harness_installed  # noqa: F401 -- a fixture
from tests.utils.snippets import SHELF, fence_under, run_fence

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

DOC = (SHELF / "decisions.md").read_text(encoding="utf-8")


@pytest.fixture
def hub(decision_double):
    """The shared Decision API double (``tests/utils/decision_double.py``), under this file's old name."""
    return decision_double


async def test_one_decision(hub):
    ns = await run_fence(fence_under(DOC, "1."))
    assert ns["result"].pick("target", min=0.85) == "view:data-sources"
    assert ns["result"].endpoint == f"api_endpoint-{DECIDER['id']}"
    assert hub["invoked"] == [(DECIDER["id"], "v1/systemone")]


async def test_which_endpoint_answers(hub):
    ns = await run_fence(fence_under(DOC, "2."))
    assert [(o.name, o.host) for o in ns["deciders"]] == [("Jev (TypeSafe)", "api.typesafe.ai")]


async def test_three_kinds_then_act_only_when_sure(hub):
    ns = await run_fence(fence_under(DOC, "3."))
    assert ns["route"] == "billing" and ns["urgency"] == 1.0 and ns["escalate"] == 0.9
    assert ns["result"].answers["urgency"].probabilities["today"] == 0.7, "keyed by the level's text"
    ns = await run_fence(fence_under(DOC, "4."), ns)
    assert ns["key"] == "billing"


async def test_when_it_cannot_answer(hub):
    ns = await run_fence(fence_under(DOC, "1."))
    hub["status"] = 429
    ns = await run_fence(fence_under(DOC, "5."), ns)
    assert ns["reason"] == "rate_limited"


async def test_the_magic_line_route(hub):
    ns = await run_fence(fence_under(DOC, "7."))
    assert ns["answer"].route == "quick" and ns["answer"].target.value == "data-sources"
    assert hub["invoked"] == [], "an exact screen name is a rule: no decision is spent"


@pytest.mark.usefixtures("harness_installed")
async def test_availability_on_the_funding_status(hub):
    ns = await run_fence(fence_under(DOC, "8."))
    assert ns["decision"].available and ns["decision"].name == "Jev (TypeSafe)"


async def test_a_decision_as_a_wizard_step(hub, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    ns = await run_fence(fence_under(DOC, "9."))
    result = ns["result"]
    assert result.ok and result.steps["route"].met and result.steps["billing"].ran
    assert not result.steps["bugs"].ran and result.stopped_at == ""
    assert hub["invoked"] == [(DECIDER["id"], "v1/systemone")], "one call answered the gate"

