"""``llm-endpoint`` on ``compute_node/@local``: the hub's channel for pointing this
box's coding-CLI harnesses at a hub ``LLMEndpoint`` after login.

Driven over HTTP through the real app so the envelope the hub's
``call_box_action`` parses is what is asserted, not the helper's return value.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import HUB_ENDPOINT_HARNESSES

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PATH = "/api/v1/graph/compute_node/@local/llm-endpoint"
INVOKE_PATH = "/api/v1/graph/llm_endpoint/ep1/invoke"
BIND = {"endpoint_typeid": "llm_endpoint:ep1", "invoke_path": INVOKE_PATH, "provider": "openrouter", "name": "OR"}


def _patch_hub_key(monkeypatch, key: str | None) -> None:
    """Make ``resolve_hub_api_key`` answer ``key``.

    Patched at the resolver, not the store, because the API suite's instance settings are
    process-cached and must not be reset under other tests. The double mirrors the real
    keyword-only signature: callers that must know whether this box can act on the hub *now*
    pass ``require_live=True``, and a double that cannot take it turns their call into a 500
    rather than an answer. One helper, so the next argument added to the resolver is a
    one-line edit here instead of a four-site sweep -- which is exactly what the last one was.
    """
    monkeypatch.setattr(
        "flow_sdk.cli.auth.hub_login.resolve_hub_api_key",
        lambda *, require_live=False: key,
    )


@pytest.fixture
def hub_login(monkeypatch):
    """A box the hub has logged in."""
    _patch_hub_key(monkeypatch, "fp-hub-key")
    yield


@pytest.fixture
def hub_logged_out(monkeypatch):
    """A box with no hub login -- the precondition every ``*_without_login_is_409`` test states."""
    _patch_hub_key(monkeypatch, None)
    yield


@pytest.fixture(autouse=True)
async def _clean_binding():
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import unbind_hub_llm_endpoint
    from flow_sdk.instance_settings import llm_endpoint

    llm_endpoint.reset_cache()
    yield
    await unbind_hub_llm_endpoint()
    llm_endpoint.reset_cache()


@pytest.mark.asyncio
async def test_get_unbound(bootstrapped_client):
    r = await bootstrapped_client.get(PATH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "SUCCESS"
    assert body["data"]["endpoint_typeid"] is None
    assert body["data"]["active_for"] == []


@pytest.mark.asyncio
async def test_bind_then_get_then_unbind(bootstrapped_client, hub_login):
    r = await bootstrapped_client.post(PATH, json=BIND)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert r.json()["status"] == "SUCCESS"
    assert data["endpoint_typeid"] == "llm_endpoint:ep1"
    assert data["invoke_path"] == INVOKE_PATH
    assert data["invoke_url"].endswith(INVOKE_PATH)
    assert data["hub_logged_in"] is True
    assert len(data["active_for"]) == len(HUB_ENDPOINT_HARNESSES)

    r = await bootstrapped_client.get(PATH)
    assert r.json()["data"]["endpoint_typeid"] == "llm_endpoint:ep1"

    # The keys list the modal renders shows the managed row as configured.
    r = await bootstrapped_client.get("/api/v1/graph/compute_node/@local/lm_keys")
    assert r.status_code == 200, r.text
    rows = [k for k in r.json()["data"] if k["provider"] == "flowpad"]
    assert rows and rows[0]["managed"] is True and rows[0]["configured"] is True

    r = await bootstrapped_client.delete(PATH)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["was_bound"] is True
    assert "reverted" not in data, "binding no longer writes to Capability, so nothing is reverted"
    assert data["endpoint_typeid"] is None

    r = await bootstrapped_client.get("/api/v1/graph/compute_node/@local/lm_keys")
    assert [k for k in r.json()["data"] if k["provider"] == "flowpad"] == []


@pytest.mark.asyncio
async def test_bind_without_login_is_409(bootstrapped_client, hub_logged_out):
    r = await bootstrapped_client.post(PATH, json=BIND)
    body = r.json()
    assert body["status"] == "FAIL"
    assert body.get("status_code") == 409 or r.status_code == 409

    r = await bootstrapped_client.get(PATH)
    assert r.json()["data"]["endpoint_typeid"] is None


@pytest.mark.asyncio
async def test_bind_malformed_is_400(bootstrapped_client, hub_login):
    r = await bootstrapped_client.post(PATH, json={"endpoint_typeid": "llm_endpoint:ep1"})
    body = r.json()
    assert body["status"] == "FAIL"
    assert body.get("status_code") == 400 or r.status_code == 400


async def test_select_lets_a_user_choose_a_source_without_a_hub(bootstrapped_client) -> None:
    """The picker's one write. It must work on a box that has never talked to a hub -- which is
    why it is a sub-action and not the bare POST, whose 409 would otherwise tell someone picking
    their own OpenRouter key that the box is not logged in."""
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability

    path = "/api/v1/graph/compute_node/@local/llm-endpoint/select"

    for payload, expected in (
        ({"harness": "claude", "kind": "api_key", "provider": "openrouter"}, ("api", "openrouter")),
        ({"harness": "claude", "kind": "device"}, ("device", None)),
    ):
        body = (await bootstrapped_client.post(path, json=payload)).json()
        assert body["status"] == "SUCCESS", body
        cap = await Capability.get_by_kind(worker_capability_kind("claude"))
        assert (cap.auth_mode, cap.api_provider) == expected, payload


async def test_select_rejects_what_it_cannot_honour(bootstrapped_client) -> None:
    path = "/api/v1/graph/compute_node/@local/llm-endpoint/select"
    for payload in (
        {"kind": "device"},  # no harness
        {"harness": "claude", "kind": "nonsense"},
        {"harness": "claude", "kind": "api_key", "provider": "nonsense"},
        {"harness": "claude", "kind": "endpoint"},  # logged out, nothing bound
    ):
        body = (await bootstrapped_client.post(path, json=payload)).json()
        assert body["status"] != "SUCCESS", f"{payload} should have been refused: {body}"


# ── test: the box's pass-through to the hub's own verdict ────────────────────────────
#
# The desktop has no other route to it. ``llm_endpoint`` is ``_api_visible=False`` -- there are
# no local rows -- so a screen calling ``/graph/llm_endpoint/<id>/test`` through dataManager
# would be asking THIS box about an entity it does not have. Hence the sub-action, beside the
# listing it already serves.

TEST_PATH = f"{PATH}/test"
VERDICT = {"ok": True, "status": 200, "model": "anthropic/claude-haiku-4.5", "latency_ms": 412, "message": ""}


@pytest.fixture
def hub_test_call(monkeypatch):
    """Capture the hub call the sub-action makes, and answer it with a verdict."""
    calls: list[tuple] = []

    async def _hub_post(entity_type, payload, entity_id=None, action=None, **kwargs):
        calls.append((entity_type, entity_id, action))
        return VERDICT

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", _hub_post)
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize("sent", ["ep1", "llm_endpoint-ep1", "llm_endpoint:ep1"])
async def test_test_forwards_to_the_hub_and_returns_the_verdict(bootstrapped_client, hub_login, hub_test_call, sent):
    """Every spelling the hub itself hands out resolves to the same bare id: the row's own
    ``id``, the typeid form in ``sources``/chain hops, and the colon form the bind payload uses.
    A caller that guessed wrong would otherwise get a 400 on a perfectly good endpoint."""
    r = await bootstrapped_client.post(TEST_PATH, json={"endpoint_typeid": sent})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "SUCCESS"
    assert body["data"] == VERDICT
    assert hub_test_call == [("llm_endpoint", "ep1", "test")]


@pytest.mark.asyncio
async def test_test_without_login_is_409(bootstrapped_client, hub_logged_out, hub_test_call):
    r = await bootstrapped_client.post(TEST_PATH, json={"endpoint_typeid": "ep1"})
    assert r.json()["status"] == "FAIL"
    assert r.json().get("status_code") == 409 or r.status_code == 409
    assert hub_test_call == [], "a signed-out box must not reach the hub at all"


@pytest.mark.asyncio
async def test_test_without_an_endpoint_is_400(bootstrapped_client, hub_login, hub_test_call):
    r = await bootstrapped_client.post(TEST_PATH, json={})
    assert r.json()["status"] == "FAIL"
    assert r.json().get("status_code") == 400 or r.status_code == 400
    assert hub_test_call == []


# ── chain: what a call through the endpoint actually spends ──────────────────────────
#
# The companion of ``test``, and the reason both exist: a verdict says the call SUCCEEDED, it
# does not say whose key paid. Same box channel, for the same reason -- the hub's ``chain``
# action addresses an entity this box has no row for.

CHAIN = {
    "entry": {"id": "llm_endpoint-ep1", "name": "mine"},
    "hops": [{"id": "llm_endpoint-root1", "name": "Acme pool", "provider": "openrouter", "is_root": True}],
    "paths": [["llm_endpoint-ep1", "llm_endpoint-root1"]],
    "missing_sources": [],
    "sticky_root_for_me": None,
}


@pytest.fixture
def hub_chain_call(monkeypatch):
    """Capture the hub GET the sub-action makes, and answer it with a chain report."""
    calls: list[tuple] = []

    async def _hub_get(entity_type, entity_id=None, action=None, **kwargs):
        calls.append((entity_type, entity_id, action))
        return {"status": "SUCCESS", "data": CHAIN}

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", _hub_get)
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize("sent", ["ep1", "llm_endpoint-ep1", "llm_endpoint:ep1"])
async def test_chain_reports_which_root_holds_the_key(bootstrapped_client, hub_login, hub_chain_call, sent):
    r = await bootstrapped_client.get(f"{PATH}/chain/{sent}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "SUCCESS"
    # Unwrapped out of the hub's envelope, and every id spelling resolves to the same bare id.
    assert body["data"] == CHAIN
    assert hub_chain_call == [("llm_endpoint", "ep1", "chain")]


@pytest.mark.asyncio
async def test_chain_without_login_is_409(bootstrapped_client, hub_logged_out, hub_chain_call):
    r = await bootstrapped_client.get(f"{PATH}/chain/ep1")
    assert r.json()["status"] == "FAIL"
    assert r.json().get("status_code") == 409 or r.status_code == 409
    assert hub_chain_call == [], "a signed-out box must not reach the hub at all"


@pytest.mark.asyncio
async def test_the_bare_get_is_still_the_status(bootstrapped_client, hub_login, hub_chain_call):
    """The sub-path is what selects the chain; without one this stays the funding status."""
    body = (await bootstrapped_client.get(PATH)).json()
    assert body["status"] == "SUCCESS"
    assert "available" in body["data"] and "hub_user_typeid" in body["data"]


# ── binding: one source rendered for a shell (``flow llm use``) ──────────────


@pytest.mark.asyncio
async def test_the_status_names_the_variables_a_shell_binding_can_set(bootstrapped_client):
    """``flow llm clear`` has no source and no credential, and still has to know which variables
    to unset. It rides the STATUS, not the credential route: the names are static and
    secret-free, and a list kept in the CLI would go stale the first time a harness gained one."""
    r = await bootstrapped_client.get(PATH)

    assert r.status_code == 200, r.text
    assert {"ANTHROPIC_BASE_URL", "CODEX_HOME", "OPENCODE_CONFIG"} <= set(r.json()["data"]["managed_vars"])


@pytest.mark.asyncio
async def test_binding_requires_a_source(bootstrapped_client):
    r = await bootstrapped_client.post(f"{PATH}/binding", json={})

    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_binding_renders_every_harness_for_a_bound_endpoint(bootstrapped_client, hub_login):
    await bootstrapped_client.post(PATH, json=BIND)

    r = await bootstrapped_client.post(f"{PATH}/binding", json={"endpoint_typeid": BIND["endpoint_typeid"]})

    assert r.status_code == 200, r.text
    harnesses = r.json()["data"]["harnesses"]
    assert set(harnesses) == set(HUB_ENDPOINT_HARNESSES)
    # claude carries the redirect in an environment variable...
    assert harnesses["claude"]["env"]["ANTHROPIC_BASE_URL"].endswith(INVOKE_PATH)
    assert harnesses["claude"]["files"] == {}
    # ...codex and opencode cannot: their base URL only moves through a file, and the only
    # variable they honour points AT it. Verified against the real CLIs (codex ignores
    # OPENAI_BASE_URL; opencode ignores OPENROUTER_BASE_URL and OPENCODE_BASE_URL).
    assert harnesses["codex"]["pointer_env"] == "CODEX_HOME"
    assert harnesses["codex"]["pointer_is_dir"] is True
    assert INVOKE_PATH in harnesses["codex"]["files"]["config.toml"]
    assert harnesses["opencode"]["pointer_env"] == "OPENCODE_CONFIG"
    assert harnesses["opencode"]["pointer_is_dir"] is False
    assert INVOKE_PATH in harnesses["opencode"]["files"]["opencode.json"]


@pytest.mark.asyncio
async def test_the_generated_codex_config_is_the_c_overrides_verbatim(bootstrapped_client, hub_login):
    """Dotted keys are valid TOML, so the file is the spawn's ``-c`` pairs one per line. If
    these two ever diverge, a terminal and a worker would reach different providers."""
    await bootstrapped_client.post(PATH, json=BIND)

    r = await bootstrapped_client.post(f"{PATH}/binding", json={"endpoint_typeid": BIND["endpoint_typeid"]})
    toml = r.json()["data"]["harnesses"]["codex"]["files"]["config.toml"]

    assert 'model_provider = "flowpad"' in toml
    assert 'model_providers.flowpad.wire_api = "responses"' in toml
    # A person typing `codex exec` passes no --model, so the slug has to be in the file.
    assert toml.startswith("model = ")


@pytest.mark.asyncio
async def test_binding_reports_a_harness_that_cannot_use_the_source(bootstrapped_client, hub_login):
    r = await bootstrapped_client.post(f"{PATH}/binding", json={"endpoint_typeid": "llm_endpoint:nobody-has-this"})

    assert r.status_code == 200, r.text
    for entry in r.json()["data"]["harnesses"].values():
        # A refusal, not an empty binding: the caller renders the sentence rather than
        # silently emitting nothing and leaving the shell unfunded.
        assert entry.get("reason")


@pytest.mark.asyncio
async def test_binding_refuses_an_unknown_harness(bootstrapped_client):
    r = await bootstrapped_client.post(f"{PATH}/binding", json={"endpoint_typeid": "x", "harness": "emacs"})

    assert r.status_code == 404, r.text


# ── project scope: rung 2, which had no writer at all ────────────────────────
#
# A real typeid, unlike ``BIND`` above: a project pin is validated as a TypeId before it is
# stored, because a malformed one would not match any candidate and would silently rule out
# every source in the project instead of failing here.
PINNED = "llm_endpoint-6f3be311-d82f-4bc6-9862-66c1e31c310c"


@pytest.mark.asyncio
async def test_select_at_project_scope_pins_the_project(bootstrapped_client, hub_login):
    from flow_sdk.builtin.project import Project

    project = await Project(name="llm-scope-test").save()
    try:
        r = await bootstrapped_client.post(
            f"{PATH}/select",
            json={"scope": "project", "project_id": str(project.id), "endpoint_typeid": PINNED},
        )

        assert r.status_code == 200, r.text
        assert (await Project.get_by_id(str(project.id))).llm_endpoint_typeid == PINNED

        # ...and an empty endpoint unpins it, so the box-wide order applies again.
        r = await bootstrapped_client.post(f"{PATH}/select", json={"scope": "project", "project_id": str(project.id)})
        assert r.status_code == 200, r.text
        assert (await Project.get_by_id(str(project.id))).llm_endpoint_typeid is None
    finally:
        await project.delete()


@pytest.mark.asyncio
async def test_a_project_pin_leaves_every_capability_alone(bootstrapped_client, hub_login):
    """The two scopes write different rows. A project pin that also flipped the box's
    preference would silently outlive the project it was made for."""
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.builtin.project import Project

    kind = worker_capability_kind("claude")
    before = getattr(await Capability.get_by_kind(kind), "auth_mode", None)
    project = await Project(name="llm-scope-untouched").save()
    try:
        await bootstrapped_client.post(
            f"{PATH}/select",
            json={"scope": "project", "project_id": str(project.id), "endpoint_typeid": PINNED},
        )

        assert getattr(await Capability.get_by_kind(kind), "auth_mode", None) == before
    finally:
        await project.delete()


@pytest.mark.asyncio
async def test_project_scope_requires_a_project(bootstrapped_client):
    r = await bootstrapped_client.post(f"{PATH}/select", json={"scope": "project", "endpoint_typeid": "x"})

    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_an_unknown_scope_is_refused_rather_than_defaulted(bootstrapped_client):
    r = await bootstrapped_client.post(
        f"{PATH}/select", json={"scope": "galaxy", "harness": "claude", "kind": "device"}
    )

    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_every_harness_gets_its_model_in_shell_scope(bootstrapped_client, hub_login):
    """A spawn passes ``--model``; a person typing the CLI passes nothing. Without the slug
    the harness asks for its own default, which a budgeted endpoint refuses outright --
    observed as claude requesting ``claude-opus-4-8`` and getting a 400 for having no price."""
    await bootstrapped_client.post(PATH, json=BIND)

    r = await bootstrapped_client.post(f"{PATH}/binding", json={"endpoint_typeid": BIND["endpoint_typeid"]})
    harnesses = r.json()["data"]["harnesses"]

    assert harnesses["claude"]["env"]["ANTHROPIC_MODEL"] == harnesses["claude"]["model"]
    assert harnesses["copilot"]["env"]["COPILOT_MODEL"] == harnesses["copilot"]["model"]
    assert harnesses["codex"]["files"]["config.toml"].startswith("model = ")
    assert harnesses["opencode"]["model"] in harnesses["opencode"]["files"]["opencode.json"]
    # ...and `clear` must know about every one of them, or a stale model outlives the source.
    status = await bootstrapped_client.get(PATH)
    assert "ANTHROPIC_MODEL" in status.json()["data"]["managed_vars"]


@pytest.mark.asyncio
async def test_every_harness_says_where_it_reads_funding_from_box_wide(bootstrapped_client, hub_login):
    """``flow llm user set`` funds a box whose only consumer is a person at a prompt, so each
    harness has to name the file IT reads by default -- three do, copilot has none."""
    await bootstrapped_client.post(PATH, json=BIND)

    r = await bootstrapped_client.post(f"{PATH}/binding", json={"endpoint_typeid": BIND["endpoint_typeid"]})
    users = {worker: entry["user"] for worker, entry in r.json()["data"]["harnesses"].items()}

    assert users["claude"] == {
        **users["claude"],
        "fmt": "json",
        "path": ".claude/settings.json",
    }
    assert users["claude"]["merge"]["env"]["ANTHROPIC_BASE_URL"].endswith(INVOKE_PATH)
    # ``fmt`` is what the APPLIER must do, and there are two things to do: merge a document, or
    # replace a managed region. Which file it is, is ``path``'s business.
    assert users["codex"]["fmt"] == "block" and users["codex"]["path"] == ".codex/config.toml"
    assert users["opencode"]["fmt"] == "json" and users["opencode"]["path"] == ".config/opencode/opencode.json"
    # copilot has no provider file and no config-dir variable, so its box-wide form is the shell
    # profile -- and it says so rather than silently writing nothing.
    assert users["copilot"]["fmt"] == "block" and users["copilot"]["note"]


@pytest.mark.asyncio
async def test_codex_box_wide_carries_the_token_as_a_header_not_env_key(bootstrapped_client, hub_login):
    """``env_key`` names an environment variable, and a person typing ``codex`` has none set --
    ``~/.codex/auth.json`` does NOT satisfy it for a custom provider. ``http_headers`` is the only
    file-only way in, so the box-wide render must drop ``env_key`` and use the header."""
    await bootstrapped_client.post(PATH, json=BIND)

    r = await bootstrapped_client.post(f"{PATH}/binding", json={"endpoint_typeid": BIND["endpoint_typeid"]})
    lines = r.json()["data"]["harnesses"]["codex"]["user"]["lines"]

    assert any("http_headers.Authorization" in line and "Bearer" in line for line in lines)
    # Dropped, not merely overridden: leaving it in makes codex demand the variable even though
    # the header would have authenticated the call. The SHELL form still uses env_key +
    # CODEX_HOME -- the two forms differ on purpose.
    assert not any("env_key" in line for line in lines)


@pytest.mark.asyncio
async def test_opencode_box_wide_inlines_the_key(bootstrapped_client, hub_login):
    """No variable is exported box-wide, so the key has to live in the file opencode reads."""
    await bootstrapped_client.post(PATH, json=BIND)

    r = await bootstrapped_client.post(f"{PATH}/binding", json={"endpoint_typeid": BIND["endpoint_typeid"]})
    merge = r.json()["data"]["harnesses"]["opencode"]["user"]["merge"]

    options = next(iter(merge["provider"].values()))["options"]
    assert options["apiKey"] and options["baseURL"].endswith(f"{INVOKE_PATH}/v1")


@pytest.mark.asyncio
async def test_an_unknown_post_sub_action_is_not_treated_as_a_bind(bootstrapped_client, hub_login):
    """The bare POST means "the hub is binding this box", so falling through to it turned any
    misspelled or newer-client sub-path into a bind — and reported a failure about the wrong
    operation entirely (a new client's POST .../binding once answered "invoke_path must be a
    hub-relative path" against an older server)."""
    r = await bootstrapped_client.post(f"{PATH}/nosuchthing", json={})

    assert r.status_code == 404, r.text
    assert "nosuchthing" in r.json()["message"]
