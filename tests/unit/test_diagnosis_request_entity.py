"""DiagnosisRequest IS a FlowpadDiagnosis: it saves and reloads like one (metadata-only, real test
DB), carries the request's own fields, and pushes to the hub only what the owner sets -- never the
fields the hub owns (the run tally, the budget it allocated)."""

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.diagnosis_request import DiagnosisRequest
from flow_sdk.builtin.flowpad_diagnosis import FlowpadDiagnosis
from flow_sdk.schema.data_spec.diagnosis_request_spec import DiagnosisFundingSpec, DiagnosisRequestOpenSpec

pytestmark = [pytest.mark.timeout(30)]  # do not increase timeout without approval

REQUEST_ID = "6b1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8"


async def test_a_request_saves_and_reloads_as_a_diagnosis_with_its_own_fields():
    request = DiagnosisRequest(
        id=REQUEST_ID,
        name="locked db",
        title="locked db",
        instructions="read server.log",
        write_expires_at="2026-10-09T00:00:00+00:00",
        max_run_bytes=2 * 1024 * 1024,
    )
    await request.save()

    loaded = await DiagnosisRequest.get_by_id(REQUEST_ID)

    assert isinstance(loaded, FlowpadDiagnosis) and loaded.instructions == "read server.log"
    assert loaded.command == f"flow diagnose {REQUEST_ID}"


def test_the_hub_body_carries_what_the_owner_sets_and_never_what_the_hub_owns():
    body = DiagnosisRequest(
        id=REQUEST_ID,
        instructions="x",
        write_expires_at="t",
        max_run_bytes=1,
        run_count=3,
        llm_endpoint_typeid="llm_endpoint-1",
        last_run_at="t",
    )._hub_body()

    assert {"instructions", "write_expires_at", "max_run_bytes"} <= set(body)
    assert not {"run_count", "llm_endpoint_typeid", "last_run_at"} & set(body)


def test_the_open_spec_bounds_the_window_the_size_and_names_one_budget_source():
    with pytest.raises(ValidationError):
        DiagnosisRequestOpenSpec(write_hours=24 * 8)
    with pytest.raises(ValidationError):
        DiagnosisRequestOpenSpec(max_run_mb=11)
    with pytest.raises(ValidationError):
        DiagnosisFundingSpec(cost_usd_total=1, source_typeid="llm_endpoint-1", local_key_provider="openrouter")
    with pytest.raises(ValidationError):
        DiagnosisFundingSpec(cost_usd_total=0, source_typeid="llm_endpoint-1")


async def test_only_prompt_shaped_assets_may_be_sent_along():
    from flow_sdk.builtin.diagnosis_request import _pack_asset

    with pytest.raises(ValueError, match="cannot be sent"):
        await _pack_asset("credential-6b1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8")


async def test_an_uploaded_key_is_reused_only_from_an_endpoint_this_user_created(monkeypatch):
    """Someone else's endpoint with the same name, shared here, must not carry the runner's traffic."""
    from flow_sdk.builtin import diagnosis_request
    from flow_sdk.cloud_client.transport import hub_http

    name = "openrouter key (uploaded for diagnosis requests)"
    listed = [{"id": "theirs", "name": name, "provider": "openrouter", "created_by": "someone-else"}]
    posted = []

    async def hub_get(*_a, **_k):
        return listed

    async def hub_post(entity_type, body, entity_id=None, action=None, *_a, **_k):
        posted.append((entity_id, action))
        return {"id": "mine"}

    monkeypatch.setattr(hub_http, "hub_get", hub_get)
    monkeypatch.setattr(hub_http, "hub_post", hub_post)
    monkeypatch.setattr("flow_sdk.cli.auth.lm_api_keys.get_lm_api", lambda _p: "sk-or-test")
    monkeypatch.setattr("flow_sdk.cli.app_config.get_user", lambda: {"id": "me"})

    first = await diagnosis_request._hub_root_for_local_key("openrouter")
    listed.append({"id": "mine", "name": name, "provider": "openrouter", "created_by": "me"})
    second = await diagnosis_request._hub_root_for_local_key("openrouter")

    assert first == "llm_endpoint-mine" and (None, None) in posted, "theirs was not reused: a new one was created"
    assert second == "llm_endpoint-mine" and len(posted) == 2, "my own is reused, with no second upload"
