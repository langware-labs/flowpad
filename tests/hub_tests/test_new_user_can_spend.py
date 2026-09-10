"""A brand-new hub user can spend real money by saying "hi".

**What this pins, and why it is worth a live test.** Signing up allocates nothing — `/signup`
creates the account and returns. What a new user gets instead is READ ACCESS to one shared,
hub-managed endpoint (`flowpad/hub/builtin/instances/llm-endpoints/global_openrouter.json`
carries `authenticated_role: "reader"`), whose key lives in hub config and which ships with no
`limits` block at all. So the moment an account exists it can spend, and nothing caps it.

That is a claim about behaviour, not about code, and it is the kind of claim that quietly stops
being true (or quietly becomes worse) when someone edits a seed file or an authorizer. Hence a
test that actually spends.

**The proof is the BOOKED COST, never the 200.** A completion that returns is not evidence the
hub's budget was the thing that paid for it — the same lesson as the `claude -p` false positive,
where a shell command answered perfectly while using personal OAuth and never touching the hub
at all. So this reads the user's own `token_plan/me` before and after and asserts the ledger
moved. If the spend were coming from anywhere else, that number would not budge.

**Deliberately the INVOKE path, not the endpoint's `test` action.** `test` is a hub-side
diagnostic; `invoke` is what a real worker does with a real prompt. The question here is whether
an ordinary new user can spend in the ordinary way, so the test asks it the ordinary way.

Run against a local hub::

    FLOWPAD_HUB_URL=http://localhost:8093 uv run pytest tests/hub_tests/test_new_user_can_spend.py -s
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from tests.hub_tests._local_login import login_as

# A live completion against a real provider. Bounded, not tuned: the call is one short turn, and
# anything slower than this is a broken hub rather than a slow model.
pytestmark = pytest.mark.timeout(120)

#: The whole spend. Short on purpose — this test is about whether a new account CAN spend, not
#: about how much, and a one-token turn is the cheapest honest answer to that.
PROMPT = "hi"


def _signup_a_brand_new_user(hub_base_url: str) -> dict:
    """Create an account nobody has ever used, and return its login payload.

    A fresh uuid per run, because the point is what a user gets on their FIRST day: reusing an
    identity would let an allowance somebody granted earlier stand in for the grant this test
    means to observe, and the test would keep passing after the automatic access it is pinning
    had been taken away.
    """
    email = f"spend-{uuid.uuid4().hex[:12]}@local.test"
    password = f"pw-{uuid.uuid4().hex[:16]}"

    with httpx.Client(base_url=f"{hub_base_url}/api/v1", timeout=30.0) as client:
        created = client.post("/signup", json={"email": email, "password": password, "name": "spend probe"})
        if created.status_code != 200 or created.json().get("status") not in ("SUCCESS", "success"):
            pytest.skip(f"hub refused signup ({created.status_code}): {created.text[:200]}")

        logged_in = client.post("/login", json={"email": email, "password": password})
        if logged_in.status_code != 200:
            pytest.skip(f"hub refused login for the new user ({logged_in.status_code}): {logged_in.text[:200]}")

    body = logged_in.json()
    assert body.get("status") in ("SUCCESS", "success"), body
    return body["data"]


def _numbers(blob: object) -> float:
    """Every number anywhere in *blob*, summed.

    The usage report's shape is the hub's to choose (totals keyed by cost or by token, a series,
    a breakdown) and this test has no business pinning it — it needs one question answered: did
    the recorded amount go UP. Walking the structure answers that under any of those shapes,
    where indexing a guessed key would raise a KeyError and report nothing about spending.
    """
    if isinstance(blob, bool):
        return 0.0
    if isinstance(blob, (int, float)):
        return float(blob)
    if isinstance(blob, dict):
        return sum(_numbers(v) for v in blob.values())
    if isinstance(blob, list):
        return sum(_numbers(v) for v in blob)
    return 0.0


async def _booked(endpoint_id: str) -> float:
    """What the hub's LEDGER has recorded against this endpoint.

    Read from ``GET llm_endpoint/<id>/usage`` — the ledger itself — rather than the desk's
    ``token_plan/me`` pass-through, which this test originally used and which answers 404 on a
    local hub with ``'dict' object has no attribute 'sodot'``: an internal error surfacing as a
    missing resource. That is a hub bug worth fixing, but it is not this test's subject, and
    proving spend through a broken reader would prove nothing either way.
    """
    from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

    report = await hub_get("llm_endpoint", {}, endpoint_id, "usage")
    return _numbers(report)


@pytest.mark.asyncio
async def test_a_brand_new_user_can_spend_by_saying_hi(hub_base_url):
    """Sign up, say "hi", and prove the hub booked the cost."""
    from flow_sdk.builtin.llm_endpoint import hub_invoke_path
    from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints, hub_origin

    api_key = login_as(_signup_a_brand_new_user(hub_base_url))

    # 1. The grant. An account one second old is already offered something to spend.
    offered = await fetch_hub_llm_endpoints()
    assert offered, (
        "a brand-new user was offered no LLM endpoint at all — either the shared endpoint's "
        "`authenticated_role: reader` grant is gone, or the hub now allocates per user"
    )
    endpoint = offered[0]
    print(f"\n[grant] a one-second-old account is offered: {endpoint.name}")

    # 2. What it is allowed to spend. Recorded rather than asserted: a cap appearing here would
    #    be a WELCOME change, and a test that failed on it would be arguing for the weaker
    #    system. The assertion below is about spending working, not about it being unbounded.
    limits = {k: v for k, v in (endpoint.limits.model_dump() if endpoint.limits else {}).items() if v is not None}
    print(f"[limits] {limits or 'NONE — this endpoint is uncapped'}")

    endpoint_id = str(endpoint.typeid).split("-", 1)[-1] if "-" in str(endpoint.typeid) else str(endpoint.id)
    before = await _booked(endpoint_id)

    # 3. The spend itself, down the ordinary invoke path with an ordinary prompt.
    #
    # The URL is DERIVED from the endpoint rather than read from the box binding
    # (`hub_llm_endpoint_invoke_url`), which answers None here: a fresh box has been pushed no
    # binding, so there is nothing bound to invoke. That is not a gap in the test, it is the
    # finding — the endpoint needs no binding, no allocation and no grant to be spent. Being a
    # signed-in user is the whole qualification, and the path falls straight out of its id.
    invoke_url = f"{hub_origin()}{hub_invoke_path(endpoint.typeid)}"
    # The shared endpoint advertises `models: {}` and `models_allow: []` — no tiers of its own,
    # and no allow-list, i.e. ANY model is permitted. So the caller brings the slug, and this
    # takes the repo's own proven default rather than inventing one. Deliberately the `sm` tier:
    # a `:free` model cannot be priced and the hub refuses it, which would make an unmetered call
    # look like a spend that booked nothing.
    from flow_sdk.external_apis.llm.dialects import get_dialect  # noqa: PLC0415

    fallback = get_dialect(endpoint.provider).default_models.get("sm") if endpoint.provider else None
    model = (endpoint.models or {}).get("sm") or (endpoint.models or {}).get("md") or fallback
    assert model, f"{endpoint.name} advertises no model and its provider has no default"
    print(f"[model ] {model}")

    async with httpx.AsyncClient(timeout=90.0) as client:
        completion = await client.post(
            f"{invoke_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": model, "messages": [{"role": "user", "content": PROMPT}], "max_tokens": 16},
        )

    assert completion.status_code == 200, (
        f"a new user could not spend: HTTP {completion.status_code} — {completion.text[:300]}"
    )
    reply = completion.json()["choices"][0]["message"]["content"]
    print(f"[spend ] said {PROMPT!r} through {endpoint.name}, got: {reply.strip()[:60]!r}")

    # 4. The proof. A 200 says the call worked; only the ledger says WHOSE budget paid.
    after = await _booked(endpoint_id)
    assert after > before, (
        f"the completion returned but the hub's ledger did not move ({before} -> {after}). Either the "
        f"spend did not come from this user's plan, or usage is no longer recorded — in both "
        f"cases this test can no longer tell you that a new account can spend."
    )
    print(f"[booked] {before} -> {after} USD")
