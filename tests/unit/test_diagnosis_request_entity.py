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


async def test_a_run_pushed_by_the_hub_posts_one_feed_entry_that_opens_the_request(monkeypatch):
    from flow_sdk.builtin.feed_entry import FeedEntry

    request = DiagnosisRequest(id="0c9e8d7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f", name="r", run_count=0)
    await request.save()

    async def pull(self):  # the hub's row: one run in
        self.run_count = 1
        await self.save()
        return self

    monkeypatch.setattr(DiagnosisRequest, "pull", pull)

    taken = await DiagnosisRequest.take_hub_update(request.id, {"run_count": 1})
    repeated = await DiagnosisRequest.take_hub_update(request.id, {"run_count": 1})

    entries = [e for e in await FeedEntry.get_all() if (e.data or {}).get("type_id") == str(request.typeid)]
    assert taken and not repeated, "a frame repeated for the same run posts nothing"
    assert len(entries) == 1 and entries[0].data["run"] == 1


async def test_an_edit_sends_the_new_instructions_to_the_hub_and_keeps_the_title_once_a_run_came_back(monkeypatch):
    """The label follows the instructions; the title only while no run has replaced it."""
    from flow_sdk.cloud_client.transport import hub_http
    from flow_sdk.schema.data_spec.diagnosis_request_spec import DiagnosisRequestEditSpec

    put: list[dict] = []

    async def hub_put(entity_type, entity_id, payload, *_a, **_k):
        put.append(payload)
        return payload

    async def pull(self):
        return self

    monkeypatch.setattr(hub_http, "hub_put", hub_put)
    monkeypatch.setattr(DiagnosisRequest, "pull", pull)

    fresh = DiagnosisRequest(id="1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f", name="old", title="old", run_count=0)
    await fresh.save()
    await fresh.edit(DiagnosisRequestEditSpec(instructions="read server.log\nthen the ui log"))
    ran = DiagnosisRequest(id="2e3f4051-6b7c-4d8e-9fa0-1b2c3d4e5f60", name="old", title="their run", run_count=2)
    await ran.save()
    await ran.edit(DiagnosisRequestEditSpec(instructions="read server.log"))

    assert put[0] == {
        "instructions": "read server.log\nthen the ui log",
        "name": "read server.log",
        "title": "read server.log",
    }
    assert "title" not in put[1]
    reloaded = await DiagnosisRequest.get_by_id(fresh.id)
    assert reloaded.instructions.startswith("read server.log") and reloaded.name == "read server.log"


async def test_the_sidebar_lists_requests_from_the_hub_newest_run_first(monkeypatch):
    """A request has no file for the indexer, so it is not default-indexed (that broke the
    indexable-types guard); the Assets sidebar lists it from the hub, like ``llm_endpoint``."""
    from flow_sdk.builtin import diagnosis_request as module
    from flow_sdk.cloud_client.transport import hub_http
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    async def hub_get_or_raise(entity_type, *_a, **_k):
        assert entity_type == "diagnosis_request"
        return [
            {
                "id": "a",
                "title": "older",
                "run_count": 1,
                "last_run_at": "2026-10-06T10:00:00+00:00",
                "instructions": "x",
            },
            {
                "id": "a1b2c3d4-0000-4000-8000-00000000000b",
                "title": "newer",
                "run_count": 2,
                "last_run_at": "2026-10-07T10:00:00+00:00",
            },
        ]

    monkeypatch.setattr(hub_http, "hub_get_or_raise", hub_get_or_raise)
    await DiagnosisRequest(id="a1b2c3d4-0000-4000-8000-00000000000b", name="newer", project_id="p1").save()

    listed = await module.mine()

    assert [r["id"][-1] for r in listed] == ["b", "a"]
    assert [r["project_id"] for r in listed] == ["p1", None], "the project comes from this computer's copy"
    assert "instructions" not in listed[1], "only what a sidebar row shows"
    assert "diagnosis_request" not in SchemaRegistry.get_default_index_types()


async def test_an_edit_asks_the_hub_for_a_new_window_from_now_and_a_new_run_size(monkeypatch):
    from datetime import UTC, datetime, timedelta

    from flow_sdk.cloud_client.transport import hub_http
    from flow_sdk.schema.data_spec.diagnosis_request_spec import DiagnosisRequestEditSpec

    posted: list[tuple] = []

    async def hub_post(entity_type, body, entity_id=None, action=None, *_a, **_k):
        posted.append((action, body))
        return {}

    async def pull(self):
        return self

    monkeypatch.setattr(hub_http, "hub_post", hub_post)
    monkeypatch.setattr(DiagnosisRequest, "pull", pull)
    request = DiagnosisRequest(id="40516273-8d9e-4fa0-b1c2-3d4e5f607182", name="r")

    await request.edit(DiagnosisRequestEditSpec(write_hours=168, max_run_mb=5))

    action, body = posted[0]
    expires = datetime.fromisoformat(body["write_expires_at"])
    assert action == "limits" and body["max_run_bytes"] == 5 * 1024 * 1024
    assert abs(expires - (datetime.now(UTC) + timedelta(days=7))) < timedelta(minutes=1)
    with pytest.raises(ValidationError):
        DiagnosisRequestEditSpec(write_hours=24 * 8)
