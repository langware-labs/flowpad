"""``/api/v1/activity`` — the verb-per-URL surface every non-Python producer reports through.

The route is the same sentence as the CLI and the Python handle: address, then verb. What
these pin is that the three spellings are one vocabulary, that the envelope is the
standard one (so ``apiClient`` can call it and no frontend needs ``fetch``), and that the
monitor's honesty about live-only work survives the HTTP hop.
"""

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from flow_sdk.activity import Activity, monitor
from flow_sdk.server.app import app

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

BASE = "/api/v1/activity"


@pytest_asyncio.fixture()
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def _clean_monitor():
    monitor.clear()
    yield
    monitor.clear()


async def post(client, path, verb, **body):
    return await client.post(f"{BASE}/{path}/{verb}", json=body)


def data(resp):
    """The payload out of the standard envelope — and an assertion that there IS one."""
    body = resp.json()
    assert "data" in body, f"not an ApiResponse envelope: {body}"
    return body["data"]


def refusal(resp) -> str:
    """The ``error_code`` of a refusal.

    Refusals ride an HTTP 200 by repo convention (``routes/display.py``):
    ``ApiFailResponse.status_code`` is a body field, so branching on the transport status
    would collapse every distinct refusal into one. Callers branch on this code.
    """
    body = resp.json()
    assert str(body["status"]).lower() == "fail", f"expected a refusal, got {body}"
    return body["data"]["error_code"]


# ---------------------------------------------------------------- reporting


async def test_a_verb_creates_the_activity_on_first_touch(client):
    """No separate start call: find-or-create is the addressing model, and a two-step
    start is a step a producer can forget."""
    resp = await post(client, "index", "inc_success")

    assert resp.status_code == 200
    assert data(resp)["done"] == 1
    assert data(resp)["state"] == "running"


async def test_the_response_is_the_resulting_snapshot(client):
    await post(client, "index", "total", value=100)
    await post(client, "index", "inc_success", value=25)
    resp = await post(client, "index", "current", value="~/notes/q3.md")

    spec = data(resp)
    assert (spec["done"], spec["total"], spec["current"]) == (25, 100, "~/notes/q3.md")


@pytest.mark.parametrize("spelling", ["inc_success", "incSuccess", "inc-success"])
async def test_every_spelling_of_a_verb_is_accepted(client, spelling):
    """One vocabulary, spelled the way each caller's language spells things: Python and
    the API use snake_case, TypeScript sends camelCase, a shell types kebab."""
    resp = await post(client, "index", spelling)

    assert resp.status_code == 200
    assert data(resp)["done"] == 1


async def test_a_deep_path_addresses_a_child(client):
    await post(client, "index/pdf", "inc_success")
    await post(client, "index/pdf/ocr", "inc_error", message="0 pages", ref="b.pdf")

    tree = data(await client.get(f"{BASE}/index"))

    assert tree["children"][0]["name"] == "pdf"
    assert tree["children"][0]["children"][0]["errors_count"] == 1


async def test_inc_error_carries_ref_and_code_and_does_not_advance_done(client):
    resp = await post(client, "index", "inc_error", message="encrypted", ref="a.pdf", code="E_ENC")

    spec = data(resp)
    assert (spec["done"], spec["errors_count"]) == (0, 1)
    assert (spec["errors"][0]["ref"], spec["errors"][0]["code"]) == ("a.pdf", "E_ENC")


async def test_inc_names_a_domain_counter(client):
    await post(client, "index", "inc", counter="orphans", n=17)
    resp = await post(client, "index", "inc", counter="orphans")

    assert data(resp)["counters"] == {"orphans": 18}


async def test_lifecycle_verbs_move_the_state(client):
    await post(client, "index", "inc_success")

    assert data(await post(client, "index", "block", message="waiting"))["state"] == "blocked"
    assert data(await post(client, "index", "resume"))["state"] == "running"

    final = data(await post(client, "index", "done", message="all good"))
    assert final["state"] == "completed"
    assert final["message"] == "all good"


async def test_scope_is_taken_from_the_body(client):
    await post(client, "run", "inc_success", scope="agentic_process-abc")

    assert monitor.get("run") is None, "the unscoped address is a different activity"
    assert monitor.get("run", scope="agentic_process-abc").done == 1


# ---------------------------------------------------------------- reading


async def test_get_returns_one_tree(client):
    Activity.get("index").total(10).inc_success()

    spec = data(await client.get(f"{BASE}/index"))

    assert (spec["path"], spec["done"], spec["total"]) == ("index", 1, 10)


async def test_get_on_a_finished_activity_is_refused_as_not_live(client):
    """The monitor holds live work. Asking it about finished work is asking the wrong
    component, and saying so beats an empty success."""
    act = Activity.get("index")
    act.inc_success()
    act.done()

    assert refusal(await client.get(f"{BASE}/index")) == "NOT_LIVE"


async def test_list_returns_live_roots(client):
    Activity.get("index").inc_success()
    Activity.get("qa").child("phase-1").inc_success()

    rows = data(await client.get(BASE))

    assert sorted(r["path"] for r in rows) == ["index", "qa"]


async def test_list_filters_by_scope(client):
    Activity.get("index").inc_success()
    Activity.get("run", scope="agentic_process-abc").inc_success()

    scoped = data(await client.get(BASE, params={"scope": "agentic_process-abc"}))
    everything = data(await client.get(BASE, params={"all": "true"}))

    assert [r["path"] for r in scoped] == ["run"]
    assert len(everything) == 2


async def test_a_completed_root_disappears_from_the_list(client):
    Activity.get("index").inc_success()
    await post(client, "index", "done")

    assert data(await client.get(BASE)) == []


# ---------------------------------------------------------------- rejection


async def test_an_unknown_verb_is_refused_and_names_the_alternatives(client):
    resp = await post(client, "index", "explode")

    assert refusal(resp) == "UNKNOWN_VERB"
    assert "inc_success" in resp.json()["message"], "the refusal teaches the vocabulary"


async def test_an_unknown_verb_does_not_create_the_activity(client):
    """A typo must not leave a phantom row on somebody's footer chip."""
    await post(client, "ghost", "explode")

    assert monitor.count() == 0


async def test_exceeding_the_depth_cap_is_refused(client):
    resp = await post(client, "a/b/c/d/e", "inc_success")

    assert refusal(resp) == "BAD_PATH"
    assert "depth cap" in resp.json()["message"]


async def test_a_bad_argument_is_a_refusal_not_a_crash(client):
    resp = await post(client, "index", "total", value="not-a-number")

    assert refusal(resp) == "BAD_ARGUMENT"


async def test_an_empty_scope_parameter_means_the_instance_scope(client):
    """A query string cannot carry ``None``. A caller that always serialises the
    parameter sends ``scope=``, and that must resolve to the instance-wide activity
    rather than to one in a scope literally named "" — which would never be found."""
    Activity.get("index").inc_success()

    assert data(await client.get(f"{BASE}/index", params={"scope": ""}))["done"] == 1
    assert [r["path"] for r in data(await client.get(BASE, params={"scope": ""}))] == ["index"]


async def test_the_emitter_is_installed_at_server_startup():
    """Without this the whole WS half is dead and nothing says so.

    The emitter captures the running event loop to defer its coalesced flushes onto, so it
    cannot be installed at import time — which means it has to be installed explicitly, and
    an explicit call is exactly the kind of thing that gets left out. It was: ticks reached
    no browser at all until the startup hook called it, and every test still passed because
    they all drive the monitor directly.
    """
    import inspect

    from flow_sdk.server import app as app_module

    source = inspect.getsource(app_module._on_server_startup)
    assert "install" in source and "activity.emit" in source, (
        "server startup must install the activity emitter, or no activity tick ever "
        "reaches a client"
    )
