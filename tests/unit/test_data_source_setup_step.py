"""``DataSource.step`` — a setup wizard's step reaching the driver's own code, and what it keeps.

A stub driver of our own declares its steps; the row is never saved to disk here (``save`` is captured),
because what is under test is the seam: which step runs, what ``check`` means, and that what a step learned
lands on the row and in the credential — and that a secret never comes back out.
"""
from __future__ import annotations

from typing import Mapping

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue
from flow_sdk.schema.data_spec.webhook_spec import DriverWebhookSpec
from flow_sdk.sources.setup_steps import SourceUpdateSpec, setup_step

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture
def stub(request, monkeypatch):
    from pydantic import create_model

    from flow_sdk.ingest.driver_runtime import DRIVERS
    from flow_sdk.schema.data_spec.data_driver_spec import AuthSpec
    from flow_sdk.sources.config import SourceConfig
    from flow_sdk.sources.families import RecordSource

    name = f"stub-{mint_uuid()[:8]}"

    class _Stub(RecordSource):
        provider = name
        Config = create_model(f"_StubConfig_{name}", __base__=SourceConfig, app_id=(str, ""), verify_token=(str, ""))

        @setup_step("app")
        async def _app(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue:
            if check:
                return ReturnedValue.satisfied("known") if self.binding.config.get("app_id") else ReturnedValue.not_yet("no app yet")
            update = SourceUpdateSpec(
                config={"app_id": values["app_id"]}, allowed_senders=[values["me"]], secrets={"secret": values["secret"]},
            )
            return ReturnedValue.satisfied("app stored", value=update)

    driver = DataDriver.for_class(
        _Stub, kind="datasource.test.stub",
        auth=AuthSpec(credential="stubcred", vars={"secret": "STUB_SECRET", "webhook_url": "STUB_WEBHOOK_URL"}),
        webhook=DriverWebhookSpec(url_var="webhook_url", methods=["GET", "POST"]),
        config={"app_id": {"type": "text"}, "verify_token": {"type": "text"}},
    )
    DRIVERS.register(driver)
    request.addfinalizer(lambda: DRIVERS.unregister(name))

    kept: dict = {"saves": 0, "credentials": []}
    #: Where each credential write went, and the project the stubbed owner lives in (a test sets it).
    written: list = []
    owner: dict = {"project": None}

    async def save(self, *_a, **_kw):
        kept["saves"] += 1

    async def set_credential_by_name(cred, values, *, project_id=None, deployment_id=None):
        kept["credentials"].append((cred, values))
        written.append(project_id)

    async def owner_project(row):
        return owner["project"]

    from flow_sdk.builtin import credential_service
    from flow_sdk.ingest import credentials as ingest_credentials

    monkeypatch.setattr(DataSource, "save", save)
    monkeypatch.setattr(ingest_credentials, "owner_project", owner_project)
    monkeypatch.setattr(credential_service, "set_credential_by_name", set_credential_by_name)
    request.node.written, request.node.owner = written, owner
    return name, kept


async def test_a_step_stores_what_it_learned_and_never_echoes_the_secret(stub):
    name, kept = stub
    source = DataSource(provider=name, name="bot", config={})

    answer = await source.step("app", values={"app_id": "123", "me": "972500000000", "secret": "s3cr3t"})

    assert answer.exit_code is ExitCode.OK
    assert source.config["app_id"] == "123" and source.allowed_senders == ["972500000000"] and kept["saves"] == 1
    assert kept["credentials"] == [("stubcred", {"STUB_SECRET": "s3cr3t"})], "keyed by the credential's env var"
    assert "s3cr3t" not in str(answer.model_dump()), "a secret goes into the credential and nowhere else"


async def test_a_step_keeps_its_secrets_where_the_source_reads_them(stub, request):
    """The owning agent's project — the one ``resolve_credentials`` reads. Writing by placement put them in
    the user scope for a saved row, so a step that ran still failed its own check."""
    from types import SimpleNamespace

    name, _kept = stub
    request.node.owner["project"] = SimpleNamespace(id="proj-owner")
    source = DataSource(provider=name, name="bot", config={}, owner=f"agent-{mint_uuid()}")

    answer = await source.step("app", values={"app_id": "1", "me": "972500000000", "secret": "s"})

    assert answer.ok and request.node.written == ["proj-owner"]


async def test_check_only_asks_and_keeps_nothing(stub):
    name, kept = stub
    source = DataSource(provider=name, name="bot", config={})
    assert (await source.step("app", check=True)).exit_code is ExitCode.NOT_YET
    assert kept == {"saves": 0, "credentials": []}


async def test_an_undeclared_step_is_not_found(stub):
    name, _ = stub
    assert (await DataSource(provider=name, name="bot").step("nope")).exit_code is ExitCode.NOT_FOUND


async def test_public_webhook_asks_the_hub_for_this_desktops_url_with_a_fresh_verify_token(stub, monkeypatch):
    from flow_sdk.cloud_client.transport import hub_http

    name, kept = stub
    asked: list = []

    async def hub_post(entity_type, payload, entity_id=None, action=None, *a, **kw):
        asked.append((entity_type, action, payload))
        return {"id": "w-1", "url": "https://hub.example/api/v1/webhook/w-1"}

    monkeypatch.setattr(hub_http, "hub_post", hub_post)
    source = DataSource(provider=name, name="bot", config={})

    answer = await source.step("public-webhook")

    ((entity, action, body),) = asked
    assert (entity, action) == ("webhook", "create_for_desktop")
    assert body["default_path"] == f"/api/v1/data_source/webhook/{name}" and body["filters"]["methods"] == ["GET", "POST"]
    token = source.config["verify_token"]
    assert token and body["verify_token"] == token, "the hub answers the handshake with the token the source keeps"
    assert kept["credentials"] == [("stubcred", {"STUB_WEBHOOK_URL": "https://hub.example/api/v1/webhook/w-1"})]
    assert answer.exit_code is ExitCode.OK


async def test_first_turn_holds_once_an_allowed_sender_spoke_and_an_answer_followed(stub, monkeypatch):
    from types import SimpleNamespace

    from flow_sdk.builtin.source_item import SourceItem

    name, _ = stub
    rows: list = []

    async def get_all(*_a, **_kw):
        return rows

    monkeypatch.setattr(SourceItem, "get_all", get_all)
    source = DataSource(provider=name, name="bot", allowed_senders=["+972 50-000-0000"])
    item = lambda who, at: SimpleNamespace(author_external_id=who, occurred_at=at)  # noqa: E731

    assert (await source.step("first-turn", check=True)).exit_code is ExitCode.NOT_YET
    rows[:] = [item("15550001111", "2026-09-28T10:00:00"), item("972500000000", "2026-09-28T10:01:00")]
    assert (await source.step("first-turn", check=True)).exit_code is ExitCode.NOT_YET, "no answer after the person yet"
    rows.append(item("15550001111", "2026-09-28T10:01:05"))
    assert (await source.step("first-turn", check=True)).exit_code is ExitCode.OK
