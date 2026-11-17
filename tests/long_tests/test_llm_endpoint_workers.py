"""Every worker answers through one hub ``LLMEndpoint``, set with ``process.set_llm_endpoint``.

Plain SDK: build an ``AgenticProcess``, tell it which budget to spend, prompt it. No compute node,
no box HTTP, no sandbox -- those belong to how a box is provisioned, not to what this proves.

What it proves is the one link nothing else covers: that naming a budget on a process is enough to
make a REAL turn spend it. ``tests/unit/test_api_auth_binding.py`` proves the resolver builds the
right spawn env; this proves a CLI actually launched with it and came back with an answer, and that
the hub's counters moved by what that answer cost.

The endpoint is shared by all four workers on purpose: usage is measured as a DELTA around each
turn, so every worker is checked against its own spend on the same ledger. Absolute totals would
pass on a stale row.

The budget is the one a new Flowpad user gets: this box signs up to the LOCAL hub as a fresh user,
whose default allowance draws on the hub's own (Vertex-funded) root. No provider key lives on this
box. Every worker runs the endpoint's ``sm`` size, and the slug the hub reports for that size is the
one each turn must be billed as -- priced from Google's list, the table the hub prices Vertex from.

Gated on ``DEEP_TESTING`` (real CLIs, real tokens) and a reachable LOCAL hub. Skips per worker when
that CLI is not installed.

    DEEP_TESTING=true FLOWPAD_HUB_URL=http://localhost:8495 \
        uv run pytest tests/long_tests/test_llm_endpoint_workers.py --long -v
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import shutil
import time
from decimal import Decimal

import httpx
import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.flowpad_types.enums import WorkerType
from tests.long_tests._transcript_helpers import assert_prompt_ok, fail_no_transcript, safe_exit
from tests.long_tests._vertex_hub import allocate, graph_path, hub_client, sign_up_and_fund
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(not test_service_config.deep_testing, reason="needs DEEP_TESTING: real CLIs, real tokens"),
    pytest.mark.asyncio,
]

#: ``(WorkerType, cli binary)``. One ENDPOINT for all four, one SIZE for all four: ``sm`` resolves
#: through the endpoint's own tiers, so the slug each harness asks for -- and the slug the hub must
#: meter -- is the one the hub reports for ``sm`` on this chain (``budget.tiers``), not one named
#: here. The allocation carries a cost limit, so that slug must be one the hub can price.
WORKERS = [
    (WorkerType.CLAUDE_CODE, "claude"),
    (WorkerType.CODEX, "codex"),
    (WorkerType.COPILOT, "copilot"),
    (WorkerType.OPENCODE, "opencode"),
]
SIZE = "sm"

PROMPT = 'Reply with exactly the single word "pong" and nothing else.'
EXPECTED = "pong"


@pytest.fixture(scope="module", autouse=True)
def _hub_session():
    """Sign this box in to the LOCAL hub as a new user -- synchronously, on purpose.

    ``flowpad_hub_url`` (set by ``sign_up_and_fund``) is what ``hub_origin()`` reads when a worker's
    spawn env is built, and the same login is what the test reads the ledger with: point them at
    different hubs and a turn would authenticate here and spend there.

    Sync because pytest gives every test its own event loop: anything async held at module scope
    (an httpx pool, for one) is bound to the loop that made it and blows up in the next test.
    """
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key
    from flow_sdk.config import default_service_config

    previous = default_service_config.flowpad_hub_url
    try:
        funded = sign_up_and_fund("worker matrix")
        assert resolve_hub_api_key(), "login_as did not leave this box logged in"
        yield funded
    finally:
        default_service_config.flowpad_hub_url = previous


def _sync_hub(hub_url: str) -> httpx.Client:
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    return httpx.Client(base_url=hub_url, headers={"Authorization": f"Bearer {resolve_hub_api_key()}"}, timeout=60.0)


@pytest.fixture
def hub(_hub_session) -> httpx.Client:
    """A fresh client per test -- see ``_hub_session`` for why nothing is shared."""
    with _sync_hub(_hub_session.hub_url) as client:
        yield client


@pytest.fixture(scope="module")
def budget(_hub_session) -> str:
    """The budget every worker's allocation draws on: the new user's default allowance. Its typeid.

    One allowance, on the hub's Vertex root: that is the "same endpoint" all four workers spend.
    Each worker then gets its own allocation off it (see ``endpoint``) -- not because they need
    separate budgets, but because a SHARED counter cannot attribute per-worker spend. The ledger is
    written after a turn finishes and buffered before it is readable, so on one shared endpoint a
    late booking from the previous worker lands inside the next worker's delta window. That is not
    a theoretical race: it made an earlier version of this test report success for a worker that
    had booked nothing.
    """
    return _hub_session.allowance


@pytest.fixture(scope="module")
def sized_slug(_hub_session) -> str:
    """The slug the hub runs ``SIZE`` as on this chain -- what every worker must be billed as."""
    slug = _hub_session.tiers.get(SIZE)
    assert slug, f"the allowance's chain reports no {SIZE!r} model: {_hub_session.tiers}"
    return slug


@pytest.fixture
def claude_home_is_flowpads(monkeypatch):
    """Make the claude CLI write its transcript where Flowpad reads it.

    The test settings put Flowpad's Claude home in the sandbox (``<sandbox>/.claude``), but leave it
    implicit, and a spawn pins ``CLAUDE_CONFIG_DIR`` only for an EXPLICIT non-native root -- so the
    CLI wrote under ``$HOME/.claude`` and ``load_history`` found no transcript for a turn the hub had
    already answered and billed. Naming the root makes the spawn pin it; an api-funded claude needs
    no login from that home.
    """
    from flow_sdk.instance_settings import get_instance_settings

    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", str(get_instance_settings().claude_home))


@pytest.fixture
def endpoint(_hub_session, budget, binary) -> str:
    """This worker's own allocation off the shared allowance, so its counters are unambiguous."""
    with hub_client(_hub_session.hub_url) as c:
        return allocate(c, budget, f"{binary} budget", 1.0)


def _entity_id(typeid: str) -> str:
    """The bare uuid half of a typeid."""
    return typeid.split("-", 1)[1]


def _usage(hub: httpx.Client, typeid: str, by: str | None = None) -> dict:
    now = int(time.time())
    params: dict = {"from": now - 7200, "to": now + 60}
    if by:
        params["by"] = by
    response = hub.get(f"/api/v1/graph/{graph_path(typeid)}/usage", params=params)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    return (data.get("breakdown") or {}) if by else data["totals"]


async def _answer(process: AgenticProcess, deadline_s: float = 240.0) -> str:
    """Wait out the turn, then return its transcript as one lowercased blob.

    ``prompt()`` starts a turn and returns as soon as the worker is up -- the answer arrives later.
    ``driver.load_history`` is what the ``get-history`` action serves and is driver-supplied, so one
    reader works for all four harnesses without mapping each one's transcript format.
    """
    deadline = time.monotonic() + deadline_s
    while time.monotonic() < deadline:
        fresh = await AgenticProcess.get_by_id(process.id) or process
        if not is_turn_busy(fresh, fresh.fetch_worker_status()):
            history = fresh.driver.load_history(fresh)
            if history:
                return json.dumps(history, default=str).lower()
        await asyncio.sleep(2.0)
    fail_no_transcript(deadline_s)


def _delta(before: dict, after: dict) -> dict:
    return {k: v - before[k] for k, v in after.items() if isinstance(v, (int, float))}


def _price_bracket(model: str, delta: dict) -> tuple[int, int]:
    """The cheapest and dearest those tokens could honestly cost, in micro-USD.

    Deliberately a BRACKET rather than a recomputed figure. Re-deriving the hub's exact charge means
    reimplementing its pricing -- per-request rounding, the cache ``max`` normalisation, the
    model-ref fallback chain -- and a second implementation of pricing inside a test is a machine for
    producing false failures, which is exactly what it did here.

    What is true regardless of implementation: cache only ever makes a token cheaper. So the charge
    must sit between "every prompt token was a cache hit" and "none of them were". That still catches
    a wrong model, a dropped counter, or an order-of-magnitude error -- the things worth catching.
    """
    import genai_prices

    # The same reconciliation the hub makes: Vertex's OpenAI surface reports ``input_tokens``
    # inclusive of cache, but Claude on its Anthropic surface reports them EXCLUSIVE, so a sum
    # would double-count and a bare input would miss most of the prompt. ``max`` is right either
    # way, and using anything else here is what put this bracket below the real charge.
    prompt = max(delta["input_tokens"], delta["cache_read_tokens"] + delta["cache_write_tokens"])

    def price(cache_read: int, cache_write: int) -> int:
        usage = genai_prices.Usage(
            input_tokens=max(prompt, cache_read + cache_write),
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
            output_tokens=delta["output_tokens"],
        )
        # A Vertex root is priced from Google's own list, under the bare model name (no publisher,
        # no ``@date`` pin, no ``-maas``) -- the hub's own first Vertex lookup.
        bare = model.rpartition("/")[2].split("@", 1)[0].removesuffix("-maas")
        try:
            calc = genai_prices.calc_price(usage, model_ref=bare, provider_id="google")
        except LookupError:
            pytest.fail(
                f"this env's price table (genai-prices {importlib.metadata.version('genai-prices')}) has no "
                f"Google price for {bare!r}, which the hub bills -- the bracket cannot be checked against it"
            )
        return int(Decimal(calc.total_price) * 1_000_000)

    # Which of the two is actually larger is a property of the price table, not something to assume.
    low, high = sorted(
        (
            price(0, 0),
            price(delta["input_tokens"] + delta["cache_read_tokens"], delta["cache_write_tokens"]),
        )
    )
    return low, high


async def _settled_delta(hub: httpx.Client, typeid: str, before: dict, deadline_s: float = 30.0) -> dict:
    """The usage delta once the hub has actually written it.

    Two lags sit between a finished turn and a readable number, and neither is reachable from here:
    a streamed answer is booked in the relay's ``finally`` (after the client drains it), and the
    hub's ledger coalesces in memory before flushing. An immediate read sees zero and says the turn
    never happened. Poll until the request lands, then take the delta.
    """
    deadline = time.monotonic() + deadline_s
    while True:
        delta = _delta(before, _usage(hub, typeid))
        if delta["requests"] >= 1 or time.monotonic() >= deadline:
            return delta
        await asyncio.sleep(1.0)


@pytest.mark.timeout(600)  # do not increase without approval
@pytest.mark.parametrize("worker_type, binary", WORKERS, ids=[w[1] for w in WORKERS])
async def test_worker_answers_through_the_endpoint_it_was_given(
    hub, endpoint, sized_slug, claude_home_is_flowpads, tmp_path, worker_type, binary
):
    billed_as = sized_slug
    if shutil.which(binary) is None:
        pytest.skip(f"{binary} CLI not installed")

    before = _usage(hub, endpoint)

    process = await AgenticProcess(
        worker_type=worker_type,
        workdir=str(tmp_path),
        cli_config={"model": SIZE},
        visible=False,
        # Print mode: one spawn, one turn, then done. A PTY process holds a long-lived worker whose
        # answer only ever lands in a transcript, which is a slower and less direct thing to assert
        # on when the question is simply "did this budget produce this word".
        pty_mode=False,
    ).save()
    try:
        # THE interface: naming the budget is all a caller does. No harness auth mode is touched --
        # if that were required, `set_llm_endpoint` would be half an interface.
        await process.set_llm_endpoint(endpoint)
        assert process.llm_endpoint_typeid == endpoint

        # Check the spawn INPUTS before the turn, not just the ledger after it. Without this a
        # harness that quietly fell back to its own credentials looks identical to one whose booking
        # was slow, and both surface as "booked no request" long after the evidence is gone.
        auth = await resolve_worker_api_auth(process)
        assert auth is not None, f"{binary}: naming an endpoint did not put this process in api mode"
        # All THREE channels a harness can be pointed through: env (claude, copilot), codex's
        # ``-c`` overrides, and opencode's generated provider block. Checking fewer would pass a
        # harness that is not actually redirected.
        reach = json.dumps(
            {"env": auth.env, "config_overrides": auth.config_overrides, "provider": auth.provider_options}
        )
        assert _entity_id(endpoint) in reach, (
            f"{binary}: spawn inputs do not point at the endpoint -- this turn would spend "
            f"something else: {reach[:400]}"
        )

        result = await process.prompt(PROMPT)
        assert_prompt_ok(result)
        answer = await _answer(process)
        assert EXPECTED in answer, f"{binary} did not answer through the endpoint: {answer[:600]}"
    finally:
        await asyncio.shield(safe_exit(process))

    delta = await _settled_delta(hub, endpoint, before)
    assert delta["requests"] >= 1, f"{binary}: the turn booked no request"
    assert delta["input_tokens"] > 0 and delta["output_tokens"] > 0, (
        f"{binary}: the greeting and its answer must both show up "
        f"({delta['input_tokens']} in / {delta['output_tokens']} out)"
    )
    assert delta["cost_micro_usd"] > 0, f"{binary}: {billed_as} was billed nothing"
    assert not delta["errors"], f"{binary}: {delta['errors']} upstream error(s)"
    # A harness turn is a system prompt plus tools, never a handful of tokens. A counter that moved
    # by 1 would satisfy "> 0" while meaning the accounting is broken.
    # Measured on the prompt, not on ``input_tokens`` alone: a provider that reports input EXCLUSIVE
    # of cache (a claude turn can be ~10 in + ~23k cache), so the same ``max`` reconciliation as
    # ``_price_bracket`` is the honest size of the turn.
    prompt_tokens = max(delta["input_tokens"], delta["cache_read_tokens"] + delta["cache_write_tokens"])
    assert prompt_tokens >= 20, (
        f"{binary}: {prompt_tokens} prompt tokens ({delta['input_tokens']} in, "
        f"{delta['cache_read_tokens']} cache-read, {delta['cache_write_tokens']} cache-write) is not a real turn"
    )

    # The charge must be what those tokens are actually worth. Recomputed from the same price table
    # the hub bills from, so this catches a mis-priced model, a dropped cache field, or a rounding
    # regression -- none of which a "cost > 0" check would notice.
    # The charge must be defensible for the tokens that were counted -- see ``_price_bracket``.
    #
    # This is also the check that the turn was billed AS ``billed_as``: the hub's per-model
    # breakdown (``usage?by=model``) is admin-only, and a new user only spends its allowance, so the
    # slug is pinned by price instead. With no cache tokens the bracket collapses to one figure, and
    # another size of the same family is priced several times over.
    low, high = _price_bracket(billed_as, delta)
    slack = max(delta["requests"], 1)  # per-request rounding to micro-USD
    assert low - slack <= delta["cost_micro_usd"] <= high + slack, (
        f"{binary}: billed {delta['cost_micro_usd']}µ$, outside the {low}-{high}µ$ those tokens "
        f"could cost ({delta['input_tokens']} in / {delta['output_tokens']} out / "
        f"{delta['cache_read_tokens']} cache-read / {delta['cache_write_tokens']} cache-write "
        f"of {billed_as})"
    )
    print(
        f"\n  {binary:9s} {delta['requests']:2d} req  "
        f"{delta['input_tokens']:6d} in  {delta['output_tokens']:5d} out  "
        f"{delta['cache_read_tokens']:5d} cache  ${delta['cost_micro_usd'] / 1_000_000:.6f}  [{billed_as}]"
    )
