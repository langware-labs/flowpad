"""Local Vertex provider, real endpoint/config/binding seams; transport-only fakes."""

import asyncio
import json
from datetime import datetime, timedelta
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from flow_sdk.builtin.llm_endpoint import LLMEndpoint, LLMEndpointConfig
from flow_sdk.external_apis.llm import vertex
from flow_sdk.external_apis.llm.errors import LLMAuthError, LLMNotSupported, LLMRateLimited
from flow_sdk.schema.data_spec.llm_model_spec import VertexConfig
from tests.unit.test_llm_endpoint_rows import env  # noqa: F401


@pytest.fixture(scope="module")
def credential():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return json.dumps(
        {
            "type": "service_account",
            "project_id": "test-project",
            "private_key_id": "synthetic",
            "private_key": key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
            ).decode(),
            "client_email": "test@test-project.iam.gserviceaccount.com",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    )


@pytest.fixture
def oauth(monkeypatch):
    from google.auth.transport.requests import Request

    calls = []

    def request(_self, *args, **kwargs):
        calls.append(1)
        return SimpleNamespace(
            status=200, data=b'{"access_token":"synthetic-token","expires_in":3600,"token_type":"Bearer"}'
        )

    monkeypatch.setattr(Request, "__call__", request)
    vertex._credentials.clear()
    vertex._refreshes.clear()
    return calls


def transport(monkeypatch, handler):
    class Client(httpx.AsyncClient):
        def __init__(self, **kwargs):
            super().__init__(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", Client)


def test_config_defaults_and_conflicts(credential):
    base, config = vertex.canonical_config("", credential=credential)
    assert base.endswith("/projects/test-project/locations/global")
    assert config == VertexConfig(project_id="test-project", location="global")
    with pytest.raises(ValueError, match="conflicts"):
        vertex.canonical_config(base, VertexConfig(project_id="different"), credential)
    with pytest.raises(LLMNotSupported, match="raw API keys"):
        vertex.service_account("raw-key-not-json")
    with pytest.raises(LLMAuthError):
        vertex.service_account('{"type":"service_account","private_key":"broken"}')


def test_routes_are_model_owned():
    path, body = vertex.route("anthropic/claude-sonnet-4.6", {"max_tokens": 1}, stream=True)
    assert path == "publishers/anthropic/models/claude-sonnet-4-6:streamRawPredict"
    assert body["anthropic_version"] == "vertex-2023-10-16" and "model" not in body
    path, body = vertex.route("gemini-2.5-flash", {}, stream=False)
    assert path == "endpoints/openapi/chat/completions" and body["model"] == "google/gemini-2.5-flash"
    with pytest.raises(LLMNotSupported):
        vertex.route("google/../../escape", {}, stream=False)


async def test_refresh_is_singleflight_and_renews_expired_token(credential, oauth):
    assert await asyncio.gather(*(vertex.access_token(credential) for _ in range(5))) == ["synthetic-token"] * 5
    assert len(oauth) == 1
    next(iter(vertex._credentials.values())).expiry = datetime.utcnow() - timedelta(seconds=1)
    assert await vertex.access_token(credential) == "synthetic-token"
    assert len(oauth) == 2


async def test_cancelling_a_waiter_does_not_cancel_the_shared_refresh(credential, oauth, monkeypatch):
    from google.auth.transport.requests import Request

    entered, release, calls = asyncio.Event(), Event(), []
    loop = asyncio.get_running_loop()

    def request(_self, *args, **kwargs):
        calls.append(1)
        loop.call_soon_threadsafe(entered.set)
        release.wait()
        return SimpleNamespace(status=200, data=b'{"access_token":"synthetic-token","expires_in":3600}')

    monkeypatch.setattr(Request, "__call__", request)
    first = asyncio.create_task(vertex.access_token(credential))
    await entered.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    second = asyncio.create_task(vertex.access_token(credential))
    try:
        await asyncio.sleep(0)
        assert calls == [1]
    finally:
        release.set()
    assert await second == "synthetic-token" and calls == [1]


def test_legacy_shell_keeps_final_auth_overrides():
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import shell_secret_env

    command = {"ANTHROPIC_API_KEY": "ambient", "GOOGLE_APPLICATION_CREDENTIALS": "/ambient.json", "KEEP": "yes"}
    bound = {**command, "ANTHROPIC_API_KEY": "", "GOOGLE_APPLICATION_CREDENTIALS": "/owned.json"}
    injected = shell_secret_env(command, bound)
    assert command == {"KEEP": "yes"}
    assert injected == {"ANTHROPIC_API_KEY": "", "GOOGLE_APPLICATION_CREDENTIALS": "/owned.json"}


@pytest.mark.parametrize("model", ["google/gemini-2.5-flash", "claude-sonnet-4-6"])
async def test_completion_json_and_stream_share_configured_route(monkeypatch, credential, oauth, model):
    requests = []

    def handler(request):
        body = json.loads(request.content)
        requests.append((str(request.url), body))
        assert request.headers["authorization"] == "Bearer synthetic-token"
        assert "private_key" not in request.content.decode()
        if body["stream"]:
            delta = (
                {"delta": {"text": "done"}}
                if vertex.is_claude(model)
                else {"choices": [{"delta": {"content": "done"}}]}
            )
            return httpx.Response(
                200, text="data: " + json.dumps(delta) + '\n\ndata: {"choices":[],"usage":null}\n\ndata: [DONE]\n\n'
            )
        data = (
            {"content": [{"type": "text", "text": '{"ok":true}'}]}
            if vertex.is_claude(model)
            else {"choices": [{"message": {"content": '{"ok":true}'}}]}
        )
        return httpx.Response(200, json=data)

    transport(monkeypatch, handler)
    endpoint = LLMEndpoint(
        provider="vertex", api_key=credential, base_url=vertex.canonical_config("", credential=credential)[0]
    )
    assert await endpoint.create_completion("", "answer", model=model, json_reply=True) == {"ok": True}
    assert (
        "".join([chunk async for chunk in await endpoint.create_completion("", "answer", model=model, stream=True)])
        == "done"
    )
    assert all("projects/test-project/locations/global/" in url for url, _ in requests)


async def test_declared_catalog_and_typed_unsupported(credential):
    client = LLMEndpoint(provider="vertex", api_key=credential).client()
    catalog = await client.model_catalog()
    assert all(item.catalog_source == "declared" for item in catalog)
    assert next(item for item in catalog if item.id == "claude-sonnet-4-6").formats == ["messages"]
    with pytest.raises(LLMNotSupported, match="embeddings"):
        await client.create_embeddings_with_model(["text"])


async def test_invalid_save_is_atomic_and_configuration_save_spends_nothing(env, credential, oauth):  # noqa: F811
    from flow_sdk.cli.auth.lm_api_keys import get_lm_api, validate_lm_api

    endpoint = await LLMEndpoint.by_provider("vertex", credential)
    with pytest.raises(ValueError, match="conflicts"):
        await LLMEndpoint.by_provider(
            "vertex",
            credential,
            LLMEndpointConfig(base_url=endpoint.base_url, vertex=VertexConfig(project_id="different")),
        )
    assert get_lm_api("vertex") == credential
    assert (await LLMEndpoint.find_by_secret("lm_api.vertex")).base_url == endpoint.base_url
    verdict = await validate_lm_api("vertex", configuration_only=True)
    assert verdict["validation_stage"] == "configuration" and "valid" not in verdict and oauth == []
    wire = endpoint.to_wire()
    assert wire["vertex"]["project_id"] == "test-project" and wire["credential_kind"] == "service_account"
    assert "private_key" not in str(wire) and "synthetic" not in str(wire)


async def test_settings_edit_and_test_use_saved_project_and_model(env, credential, oauth, monkeypatch):  # noqa: F811
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import _test_api_key
    from flow_sdk.cli.auth.lm_api_keys import list_provider_models, validate_lm_api

    endpoint = await LLMEndpoint.by_provider("vertex", credential)
    changed = await LLMEndpoint.by_provider(
        "vertex",
        config=LLMEndpointConfig(
            vertex=VertexConfig(project_id="edited-project", location="us-east5"), tiers={"sm": "claude-sonnet-4-6"}
        ),
    )
    assert changed.id == endpoint.id
    requests = []
    transport(
        monkeypatch,
        lambda request: (
            requests.append(request) or httpx.Response(200, json={"content": [{"type": "text", "text": "ok"}]})
        ),
    )
    assert (await validate_lm_api("vertex"))["valid"] is True
    assert (await _test_api_key("vertex"))["ok"] is True
    assert all("projects/edited-project/locations/us-east5/publishers/anthropic" in str(req.url) for req in requests)
    assert all(json.loads(req.content)["max_tokens"] == 1 for req in requests)
    assert all(item["catalog_source"] == "declared" for item in await list_provider_models("vertex"))


def test_native_binding_refuses_gemini_and_never_exports_json(credential):
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _claude_vertex_binding, shell_binding

    endpoint = LLMEndpoint(provider="vertex")
    auth = _claude_vertex_binding(endpoint, credential, "anthropic/claude-sonnet-4.6")
    assert auth.model_slug == "claude-sonnet-4-6" and auth.env["CLAUDE_CODE_USE_VERTEX"] == "1"
    assert auth.env["ANTHROPIC_API_KEY"] == auth.env["ANTHROPIC_AUTH_TOKEN"] == ""
    assert "private_key" not in str(auth.env) and credential not in repr(auth)
    with pytest.raises(LLMNotSupported):
        _claude_vertex_binding(endpoint, credential, "google/gemini-2.5-flash")
    with pytest.raises(ValueError, match="managed worker"):
        shell_binding("claude", auth)


def test_artifact_permissions_rotation_and_late_exit(credential):
    from flow_sdk.builtin.agentic_process.cli_drivers.credential_artifacts import (
        CredentialArtifact,
        cleanup,
        materialize,
        on_exit_cleanup,
    )

    process = SimpleNamespace(id="isolated-artifact-test")
    artifact = CredentialArtifact("GOOGLE_APPLICATION_CREDENTIALS", credential)
    first = Path(materialize(process, artifact)[artifact.env_var])
    assert first.stat().st_mode & 0o777 == 0o600 and first.parent.stat().st_mode & 0o777 == 0o700
    finish_old = on_exit_cleanup(process, lambda _: None)
    second = Path(materialize(process, artifact)[artifact.env_var])
    finish_old(0)
    assert not first.exists() and second.exists() and first != second
    cleanup(process)
    cleanup(process)
    assert not second.exists()


def test_unsupported_local_pin_cannot_become_a_hub_projection():
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import CODEX_API_AUTH_SPEC
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import _apply_constraint, _key_sources
    from flow_sdk.schema.data_spec.llm_source_spec import LLMSourceOrigin

    endpoint = LLMEndpoint(provider="vertex")
    candidates = _key_sources(CODEX_API_AUTH_SPEC, {"lm_api.vertex": endpoint}, {"vertex"})
    pinned = _apply_constraint(candidates, str(endpoint.typeid), LLMSourceOrigin.PROCESS, False, None, True)
    chosen = next(c for c in pinned if c.source.endpoint_typeid == str(endpoint.typeid))
    assert chosen.endpoint.kind == "api_key" and not chosen.source.eligible
    assert chosen.source.reason_code == "unsupported_provider"


async def test_rate_limit_is_not_an_authentication_failure(monkeypatch, credential, oauth):
    transport(monkeypatch, lambda _: httpx.Response(429, json={"error": {"message": "quota exhausted"}}))
    endpoint = LLMEndpoint(provider="vertex", api_key=credential)
    with pytest.raises(LLMRateLimited):
        await endpoint.create_completion("", "hi")
    result = await endpoint.probe()
    assert result.status == 429 and not result.ok
