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

Gated on ``DEEP_TESTING`` (real CLIs, real tokens), a reachable hub, and a hub login. Skips per
worker when that CLI is not installed.

    DEEP_TESTING=true FLOWPAD_HUB_URL=http://localhost:8002 OPENROUTER_API_KEY=... \
        uv run pytest tests/long_tests/test_llm_endpoint_workers.py -v

The hub it points at must be a DEDICATED instance with its OWN secret file:

    PORT=8002 NEO4J_DATABASE=<fresh> SOD_FILE_NAME=/abs/path/sod.dedicated \
        python -m flowpad.run

``SOD_FILE_NAME`` is not optional and not cosmetic. The file-backed secret store keeps every secret
in ONE file, read-modify-written with no locking, and it defaults to ``<repo>/sod.local`` -- so two
hubs started from the same checkout share it and silently drop each other's entries. The symptom is
vicious: an endpoint keeps its ``****last4`` hint and starts refusing every call with "no root with
a credential" a minute or so later, so a fast run passes and a slow one fails whichever workers
happen to run last.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from decimal import Decimal
from urllib.parse import urlparse

import httpx
import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.flowpad_types.enums import WorkerType
from tests.long_tests._transcript_helpers import assert_prompt_ok, safe_exit
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(not test_service_config.deep_testing, reason="needs DEEP_TESTING: real CLIs, real tokens"),
    pytest.mark.asyncio,
]

HUB_URL = (os.environ.get("FLOWPAD_HUB_URL") or "").rstrip("/")

#: ``(WorkerType, cli binary, model as that CLI names it, slug the hub will meter)``.
#:
#: One ENDPOINT for all four; only the model differs, because claude speaks the Anthropic Messages
#: skin, codex and copilot speak OpenAI skins, and opencode namespaces its slugs by provider. Every
#: slug is in the hub's price table -- the allocation carries a cost limit, and the hub refuses a
#: model it cannot price where a cost limit could not meter it.
WORKERS = [
    (WorkerType.CLAUDE_CODE, "claude", "anthropic/claude-haiku-4.5", "anthropic/claude-haiku-4.5"),
    (WorkerType.CODEX, "codex", "openai/gpt-4o-mini", "openai/gpt-4o-mini"),
    (WorkerType.COPILOT, "copilot", "openai/gpt-4o-mini", "openai/gpt-4o-mini"),
    (WorkerType.OPENCODE, "opencode", "openrouter/openai/gpt-4o-mini", "openai/gpt-4o-mini"),
]

PROMPT = 'Reply with exactly the single word "pong" and nothing else.'
EXPECTED = "pong"


@pytest.fixture(scope="module", autouse=True)
def _hub_session():
    """Point the SDK at the hub and log this box in -- synchronously, on purpose.

    Both halves matter: the client is how the test creates the endpoint, and ``flowpad_hub_url`` is
    what ``hub_origin()`` reads when a worker's spawn env is built. Point them at different hubs and
    a turn would authenticate here and spend there.

    Sync because pytest gives every test its own event loop: anything async held at module scope
    (an httpx pool, for one) is bound to the loop that made it and blows up in the next test. The
    login is ``/login/local``, the same funnel the hub tier uses -- nothing here reaches for a
    credential belonging to a person.
    """
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key
    from flow_sdk.config import default_service_config
    from tests.hub_tests._local_login import login_as

    if not HUB_URL:
        pytest.skip("FLOWPAD_HUB_URL is not set -- point this at a DEDICATED hub, never production")
    if urlparse(HUB_URL).hostname not in {"localhost", "127.0.0.1", "::1"}:
        pytest.skip(f"refusing to run against a non-local hub: {HUB_URL}")

    previous = default_service_config.flowpad_hub_url
    default_service_config.flowpad_hub_url = HUB_URL
    try:
        with httpx.Client(base_url=HUB_URL, timeout=30.0) as anon:
            try:
                health = anon.get("/api/v1/health/status")
            except httpx.ConnectError:
                pytest.skip(f"hub not reachable at {HUB_URL}")
            if health.status_code != 200:
                pytest.skip(f"hub health {health.status_code}")
            login = anon.post("/api/v1/login/local")
            if login.status_code != 200:
                pytest.skip(f"local hub login failed: {login.status_code} {login.text[:200]}")
            login_as(login.json()["data"])
        assert resolve_hub_api_key(), "login_as did not leave this box logged in"
        yield
    finally:
        default_service_config.flowpad_hub_url = previous


def _sync_hub() -> httpx.Client:
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    return httpx.Client(base_url=HUB_URL, headers={"Authorization": f"Bearer {resolve_hub_api_key()}"}, timeout=60.0)


@pytest.fixture
def hub(_hub_session) -> httpx.Client:
    """A fresh client per test -- see ``_hub_session`` for why nothing is shared."""
    with _sync_hub() as client:
        yield client


@pytest.fixture(scope="module")
def budget(_hub_session) -> str:
    """The ROOT every worker's budget draws on. Returns its typeid.

    One root, funded once: that is the "same endpoint" all four workers spend. Each worker then gets
    its own allocation off it (see ``endpoint``) -- not because they need separate budgets, but
    because a SHARED counter cannot attribute per-worker spend. The ledger is written after a turn
    finishes and buffered before it is readable, so on one shared endpoint a late booking from the
    previous worker lands inside the next worker's delta window. That is not a theoretical race: it
    made an earlier version of this test report success for a worker that had booked nothing.
    """
    with _sync_hub() as c:
        made = c.post("/api/v1/graph/llm_endpoint", json={"name": "worker matrix root"})
        assert made.status_code == 200, made.text
        root_id = made.json()["data"]["id"]
        keyed = c.post(f"/api/v1/graph/llm_endpoint/{root_id}/credential", json={"key": _openrouter_key()})
        assert keyed.status_code == 200, keyed.text
        # A hint alone does not mean the key is readable: with a file-backed secret store it does not
        # survive a hub restart, leaving an endpoint that LOOKS configured and refuses every call.
        chain = c.get(f"/api/v1/graph/llm_endpoint/{root_id}/chain")
        hops = chain.json()["data"]["hops"]
        assert hops and hops[0]["has_credential"], (
            "the root has no readable credential -- if it carries a hint, the secret store lost the "
            "key (a hub restart does that with sod_provider=file); re-set it"
        )
        return f"llm_endpoint-{root_id}"


@pytest.fixture
def endpoint(budget, binary) -> str:
    """This worker's own allocation off the shared root, so its counters are unambiguous."""
    with _sync_hub() as c:
        allocated = c.post(
            f"/api/v1/graph/{_graph_path(budget)}/allocate",
            json={"name": f"{binary} budget", "limits": {"cost_usd_total": 1.0}},
        )
        assert allocated.status_code == 200, allocated.text
        return f"llm_endpoint-{allocated.json()['data']['id']}"


def _openrouter_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        pytest.skip("OPENROUTER_API_KEY is not set; the endpoint would have no credential")
    return key


def _graph_path(typeid: str) -> str:
    """``"llm_endpoint-<uuid>"`` -> ``"llm_endpoint/<uuid>"``, the shape graph routes take."""
    return typeid.replace("-", "/", 1)


def _entity_id(typeid: str) -> str:
    """The bare uuid half of a typeid."""
    return typeid.split("-", 1)[1]


def _usage(hub: httpx.Client, typeid: str, by: str | None = None) -> dict:
    now = int(time.time())
    params: dict = {"from": now - 7200, "to": now + 60}
    if by:
        params["by"] = by
    response = hub.get(f"/api/v1/graph/{_graph_path(typeid)}/usage", params=params)
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
    raise AssertionError(f"no transcript after {deadline_s}s -- the turn never finished")


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

    # The same reconciliation the hub makes: OpenRouter is supposed to report ``input_tokens``
    # inclusive of cache, but an Anthropic model served through it reports them EXCLUSIVE, so a
    # sum would double-count and a bare input would miss most of the prompt. ``max`` is right
    # either way, and using anything else here is what put this bracket below the real charge.
    prompt = max(delta["input_tokens"], delta["cache_read_tokens"] + delta["cache_write_tokens"])

    def price(cache_read: int, cache_write: int) -> int:
        usage = genai_prices.Usage(
            input_tokens=max(prompt, cache_read + cache_write),
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
            output_tokens=delta["output_tokens"],
        )
        calc = genai_prices.calc_price(usage, model_ref=model, provider_id="openrouter")
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
@pytest.mark.parametrize("worker_type, binary, model, billed_as", WORKERS, ids=[w[1] for w in WORKERS])
async def test_worker_answers_through_the_endpoint_it_was_given(
    hub, endpoint, tmp_path, worker_type, binary, model, billed_as
):
    if shutil.which(binary) is None:
        pytest.skip(f"{binary} CLI not installed")

    before = _usage(hub, endpoint)
    before_by_model = _usage(hub, endpoint, by="model")

    process = await AgenticProcess(
        worker_type=worker_type,
        workdir=str(tmp_path),
        cli_config={"model": model},
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
    assert delta["input_tokens"] >= 20, f"{binary}: {delta['input_tokens']} input tokens is not a real turn"

    # The charge must be what those tokens are actually worth. Recomputed from the same price table
    # the hub bills from, so this catches a mis-priced model, a dropped cache field, or a rounding
    # regression -- none of which a "cost > 0" check would notice.
    # The charge must be defensible for the tokens that were counted -- see ``_price_bracket``.
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

    # The slug IS the price lookup, so billing the wrong one silently bills the wrong amount.
    after_by_model = _usage(hub, endpoint, by="model")
    charged = {
        slug
        for slug, totals in after_by_model.items()
        if totals.get("requests", 0) > before_by_model.get(slug, {}).get("requests", 0)
    }
    assert charged == {billed_as}, f"{binary}: billed as {sorted(charged)}, expected {billed_as!r}"
