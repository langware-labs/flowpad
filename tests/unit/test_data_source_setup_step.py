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
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue
from flow_sdk.schema.data_spec.webhook_spec import DriverWebhookSpec
from flow_sdk.sources.setup_steps import SetupShown, SourceUpdateSpec, setup_step

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

        @setup_step("show")
        async def _show(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue:
            shown = SetupShown(name="Bot", link="https://example.test/link?c=AB", code="AB")
            if check:
                return ReturnedValue.satisfied("live", value=SourceUpdateSpec(shown=shown), ran=False)
            return ReturnedValue.satisfied("ready", value=SourceUpdateSpec(owner=values["owner"], shown=shown))

        @setup_step("judge")
        async def _judge(self, *, check: bool, values: Mapping[str, str], probe: bool = False) -> ReturnedValue:
            if probe:
                return ReturnedValue.satisfied(f"probed {values.get('value', '')}", ran=False)
            return ReturnedValue.satisfied("kept", value=SourceUpdateSpec(secrets={"secret": values.get("value", "")}))

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


async def test_a_step_moves_the_owner_and_shows_without_keeping_what_it_shows(stub):
    """``owner`` lands on the row (a channel answered by one agent); ``shown`` goes back to the wizard — the
    next question binds it — and is never stored."""
    name, kept = stub
    source = DataSource(provider=name, name="bot", config={})
    agent = f"agent-{mint_uuid()}"

    answer = await source.step("show", values={"owner": agent})

    assert answer.ok and str(source.owner) == agent and kept["saves"] == 1
    assert answer.value["shown"]["link"] == "https://example.test/link?c=AB" and source.config == {}
    checked = await source.step("show", check=True)
    assert checked.ok and checked.value["shown"]["code"] == "AB" and kept["saves"] == 1, "a check shows, keeps nothing"


async def test_nudge_wakes_only_the_healthy_sources_of_that_driver(stub, monkeypatch):
    from flow_sdk.ingest import poller

    name, _ = stub
    rows = [DataSource(provider=name, name="a"), DataSource(provider=name, name="b")]
    asked: list = []
    rang: list = []

    async def get_all(query):
        asked.append(query)
        return rows

    async def save_runtime(self):
        pass

    monkeypatch.setattr(DataSource, "get_all", classmethod(lambda cls, q: get_all(q)))
    monkeypatch.setattr(DataSource, "save_runtime", save_runtime)
    monkeypatch.setattr(DataSource, "poll_refusal", lambda self: "parked" if self.name == "b" else None)
    monkeypatch.setattr(DataSource, "note_attention", lambda self: None)
    monkeypatch.setattr(poller, "wake_attention_lane", lambda: rang.append(1))

    assert await DataSource.nudge(name) == 1
    assert asked == [{"provider": name}] and rang == [1]


async def test_a_step_that_may_have_finished_setup_asks_verify_so_the_source_goes_live(stub, monkeypatch):
    """A source in setup re-verifies after a step that kept something — the person never has to find a Verify button;
    a check, or a source already live, asks nothing."""
    from flow_sdk.builtin.data_source import SourceStatus

    name, _kept = stub
    asked: list = []

    async def verify(self):
        asked.append(self.status)
        return {"ready": True}

    monkeypatch.setattr(DataSource, "verify", verify)
    source = DataSource(provider=name, name="bot", config={})
    source.status = SourceStatus.SETUP.value
    await source.step("app", check=True)
    assert asked == [], "a check changes nothing"
    await source.step("app", values={"app_id": "A1", "me": "+1", "secret": "s"})
    assert asked == [SourceStatus.SETUP.value]

    source.status = SourceStatus.ACTIVE.value
    await source.step("app", values={"app_id": "A2", "me": "+1", "secret": "s"})
    assert len(asked) == 1, "a live source is not re-verified by every step"


async def test_an_undeclared_step_is_not_found(stub):
    name, _ = stub
    assert (await DataSource(provider=name, name="bot").step("nope")).exit_code is ExitCode.NOT_FOUND


async def test_public_webhook_asks_the_hub_for_this_desktops_url_with_a_fresh_verify_token(stub, monkeypatch):

    name, kept = stub
    asked: list = []

    async def fake_call(method, entity_type, entity_id=None, action=None, *a, payload=None, **kw):
        assert method == "POST"
        asked.append((entity_type, action, payload))
        return {"id": "w-1", "url": "https://hub.example/api/v1/webhook/w-1"}

    monkeypatch.setattr(HubProxy, "call", staticmethod(fake_call))
    source = DataSource(provider=name, name="bot", config={})

    answer = await source.step("public-webhook")

    ((entity, action, body),) = asked
    assert (entity, action) == ("webhook", "create_for_desktop")
    assert body["default_path"] == f"/api/v1/data_source/webhook/{name}" and body["filters"]["methods"] == ["GET", "POST"]
    token = source.config["verify_token"]
    assert token and body["verify_token"] == token, "the hub answers the handshake with the token the source keeps"
    assert kept["credentials"] == [("stubcred", {"STUB_WEBHOOK_URL": "https://hub.example/api/v1/webhook/w-1"})]
    assert answer.exit_code is ExitCode.OK


async def test_public_webhook_claims_the_account_on_the_hub_chain_when_the_driver_declares_one(stub, monkeypatch):
    """A driver that names its account as a hub claim (``hub_claim``) gets a URL from the vendor's chain
    (``webhook/@<provider>``), delivered to THIS channel on THIS instance -- not a desktop-wide webhook."""
    from pydantic import SecretStr

    from flow_sdk.instance_settings import runtime
    from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets

    name, kept = stub
    driver = DataDriver.loaded(name)
    asked: list = []

    async def fake_call(method, entity_type, entity_id=None, action=None, *a, payload=None, **kw):
        if method == "GET":
            return {"webhooks": []}  # the step first asks which claims already deliver here
        assert method == "POST"
        asked.append((entity_type, action, payload))
        return {"id": "c-1", "url": "https://hub.example/api/v1/webhook/c-1"}

    async def credentials_for(_row):
        return ResolvedSecrets(shape=AuthShape.SECRETS, values={"secret": SecretStr("app-secret")})

    def hub_claim(cls, config, secrets):
        return {"provider": "vendor", "key": config["app_id"], "proof": {"credential": secrets["secret"]}}

    monkeypatch.setattr(HubProxy, "call", staticmethod(fake_call))
    monkeypatch.setattr(runtime, "instance_uid", lambda: "inst-1")
    monkeypatch.setattr(driver, "credentials_for", credentials_for)
    monkeypatch.setattr(driver.cls, "hub_claim", classmethod(hub_claim), raising=False)
    source = DataSource(provider=name, name="bot", config={"app_id": "A1"})

    answer = await source.step("public-webhook")

    ((entity, action, body),) = asked
    assert (entity, action) == ("webhook", "chain")
    assert body == {
        "parent": "@vendor",
        "claim": {"kind": "account", "key": "A1"},
        "proof": {"credential": "app-secret"},
        "target": {"kind": "desktop", "instance_id": "inst-1", "data_source_id": str(source.id)},
    }
    assert kept["credentials"] == [("stubcred", {"STUB_WEBHOOK_URL": "https://hub.example/api/v1/webhook/c-1"})]
    assert answer.exit_code is ExitCode.OK


async def test_public_webhook_hands_out_the_url_before_the_account_exists_then_proves_it(stub, monkeypatch):
    """A driver whose vendor app is created FROM a manifest naming its Request URL declares its claim with no key
    first: the hub holds a PENDING account claim under a URL the source keeps. Once the app exists — key and proof
    known — the same step proves THAT claim (``webhook/<id>/prove``) instead of chaining a second one, and its
    check reads not-yet in between."""
    from pydantic import SecretStr

    from flow_sdk.instance_settings import runtime
    from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets

    name, kept = stub
    driver = DataDriver.loaded(name)
    asked: list = []
    hub = {"claims": []}
    source = DataSource(provider=name, name="bot", config={})
    url = "https://hub.example/api/v1/webhook/p-1"

    async def fake_call(method, entity_type, entity_id=None, action=None, *a, payload=None, **kw):
        if method == "GET":
            return {"webhooks": hub["claims"]}
        asked.append((entity_type, entity_id, action, payload))
        if action == "chain":
            hub["claims"] = [{"id": "p-1", "status": "pending", "claim": {"kind": "account", "key": ""}, "url": url,
                              "target": {"kind": "desktop", "instance_id": "inst-1", "data_source_id": str(source.id)}}]
            return {"id": "p-1", "status": "pending", "url": url}
        if action == "prove":
            hub["claims"][0] = {**hub["claims"][0], "status": "active", "claim": {"kind": "account", "key": payload["key"]}}
            return {"id": "p-1", "status": "active", "url": url, "claim": {"kind": "account", "key": payload["key"]}}
        raise AssertionError(action)

    state = {"secrets": {}}

    async def credentials_for(_row):
        return ResolvedSecrets(shape=AuthShape.SECRETS, values={k: SecretStr(v) for k, v in state["secrets"].items()})

    def hub_claim(cls, config, secrets):
        if config.get("app_id") and secrets.get("secret"):
            return {"provider": "vendor", "key": config["app_id"], "proof": {"credential": secrets["secret"], "app_secret": "sign"}}
        return {"provider": "vendor", "key": ""}

    monkeypatch.setattr(HubProxy, "call", staticmethod(fake_call))
    monkeypatch.setattr(runtime, "instance_uid", lambda: "inst-1")
    monkeypatch.setattr(driver, "credentials_for", credentials_for)
    monkeypatch.setattr(driver.cls, "hub_claim", classmethod(hub_claim), raising=False)

    # A URL already in the shared credential is a SIBLING source's (sources of one driver share it): not this one's.
    state["secrets"] = {"webhook_url": "https://hub.example/api/v1/webhook/someone-elses"}
    assert (await source.step("public-webhook", check=True)).exit_code is ExitCode.NOT_YET, "a held URL is not a claim of this source"
    state["secrets"] = {}

    first = await source.step("public-webhook")
    assert first.exit_code is ExitCode.OK and first.value["shown"]["link"] == url and first.value["shown"]["connected"] is False
    assert asked[-1][2] == "chain" and asked[-1][3]["claim"] == {"kind": "account", "key": ""} and asked[-1][3]["proof"] == {}
    assert kept["credentials"][-1] == ("stubcred", {"STUB_WEBHOOK_URL": url}), "the URL is kept before the app exists"
    state["secrets"] = {"webhook_url": url}

    again = await source.step("public-webhook")
    assert again.exit_code is ExitCode.OK and not again.ran and len(asked) == 1, "asked again before the app exists: the same URL, no second claim"

    # The app now exists: its id and credential are known.
    source.config = {**source.config, "app_id": "A1"}
    state["secrets"] = {"webhook_url": url, "secret": "app-secret"}
    not_yet = await source.step("public-webhook", check=True)
    assert not_yet.exit_code is ExitCode.NOT_YET and "proof" in not_yet.detail

    proven = await source.step("public-webhook")
    assert proven.exit_code is ExitCode.OK and proven.value["shown"] == {"name": "", "number": "", "avatar": "", "link": url, "code": "", "qr": "", "connected": True}
    assert asked[-1][:3] == ("webhook", "p-1", "prove") and asked[-1][3] == {"key": "A1", "proof": {"credential": "app-secret", "app_secret": "sign"}}
    assert (await source.step("public-webhook", check=True)).exit_code is ExitCode.OK


async def test_a_url_another_source_of_the_driver_holds_is_not_this_sources(stub, monkeypatch):
    """The URL variable sits in the driver's credential, shared by every source of the driver on this box: a
    second source must not read the first's URL as its own (its check would hold, its claim never made, and
    the vendor app it creates would post to the FIRST source's claim)."""
    from pydantic import SecretStr

    from flow_sdk.instance_settings import runtime
    from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets

    name, _ = stub
    driver = DataDriver.loaded(name)
    first = DataSource(provider=name, name="first", config={})
    second = DataSource(provider=name, name="second", config={})
    url = "https://hub.example/api/v1/webhook/p-first"
    claims = [{"id": "p-first", "status": "pending", "claim": {"kind": "account", "key": ""}, "url": url,
               "target": {"kind": "desktop", "instance_id": "inst-1", "data_source_id": str(first.id)}}]

    async def fake_call(method, entity_type, entity_id=None, action=None, *a, payload=None, **kw):
        if method == "GET":
            return {"webhooks": claims}
        assert action == "chain" and payload["target"]["data_source_id"] == str(second.id)
        claims.append({"id": "p-second", "status": "pending", "claim": {"kind": "account", "key": ""},
                       "url": "https://hub.example/api/v1/webhook/p-second", "target": payload["target"]})
        return {"id": "p-second", "status": "pending", "url": "https://hub.example/api/v1/webhook/p-second"}

    async def credentials_for(_row):
        return ResolvedSecrets(shape=AuthShape.SECRETS, values={"webhook_url": SecretStr(url)})

    monkeypatch.setattr(HubProxy, "call", staticmethod(fake_call))
    monkeypatch.setattr(runtime, "instance_uid", lambda: "inst-1")
    monkeypatch.setattr(driver, "credentials_for", credentials_for)
    monkeypatch.setattr(driver.cls, "hub_claim", classmethod(lambda cls, config, secrets: {"provider": "vendor", "key": ""}), raising=False)

    assert (await first.step("public-webhook", check=True)).exit_code is ExitCode.OK, "the first source holds its own URL"
    not_mine = await second.step("public-webhook", check=True)
    assert not_mine.exit_code is ExitCode.NOT_YET and "own" in not_mine.detail
    made = await second.step("public-webhook")
    assert made.exit_code is ExitCode.OK and made.value["shown"]["link"].endswith("/p-second"), "the second source gets a claim of its own"


async def test_heard_is_satisfied_by_any_message_of_the_source_since_a_moment(stub, monkeypatch):
    """The generic ``heard`` step: something — anyone's message, the person's own included — arrived after
    ``since`` (else after the verify). No reply is needed: that is ``first-turn``."""
    from datetime import datetime, timedelta, timezone

    from flow_sdk.builtin.source_item import SourceItem

    name, _ = stub
    source = DataSource(provider=name, name="bot", config={})
    await source.save()
    now = datetime.now(timezone.utc)
    try:
        nothing = await source.step("heard", check=True, values={"since": (now - timedelta(minutes=5)).isoformat()})
        assert nothing.exit_code is ExitCode.NOT_YET
        row = SourceItem(data_source_id=str(source.id), provider=name, kind="ingest.message.stub", external_id="m-1",
                         name="hi", body="hi there", occurred_at=(now - timedelta(minutes=1)).isoformat(), sent_by_us=True)
        await row.save()
        heard = await source.step("heard", check=True, values={"since": (now - timedelta(minutes=5)).isoformat()})
        assert heard.exit_code is ExitCode.OK and "hi" in heard.detail and not heard.ran
        older = await source.step("heard", check=True, values={"since": now.isoformat()})
        assert older.exit_code is ExitCode.NOT_YET, "written before the moment"
        assert (await source.step("heard", check=True, values={"since": "yesterday"})).exit_code is ExitCode.NOT_YET
        timed_out = await source.step("heard", values={"since": now.isoformat(), "wait": "0"})
        assert timed_out.exit_code is ExitCode.NOT_YET
    finally:
        await source.delete()


async def test_a_probe_judges_typed_values_and_keeps_nothing(stub, monkeypatch):
    """A question's Verify runs a step as a PROBE: the step judges the typed values, nothing is kept, and a step
    that cannot judge (no ``probe`` argument, or a generic step) says so instead of running."""
    from flow_sdk.builtin import data_source as module

    kept = []
    monkeypatch.setattr(module.DataSource, "_keep", lambda self, driver, update: kept.append(update) or _done())
    name, _ = stub
    source = DataSource(provider=name, name="bot", config={})
    await source.save()
    try:
        judged = await source.step("judge", probe=True, values={"value": "v1"})
        assert judged.ok and not judged.ran and judged.detail == "probed v1" and kept == []
        assert (await source.step("app", probe=True, values={"app_id": "A"})).exit_code is ExitCode.NOT_APPLICABLE, "no probe argument"
        assert (await source.step("heard", probe=True, values={})).exit_code is ExitCode.NOT_APPLICABLE, "a generic step"
        for_real = await source.step("judge", values={"value": "v1"})
        assert for_real.ok and len(kept) == 1
    finally:
        await source.delete()


async def _done():
    return None


async def test_heard_names_this_sources_own_url_when_nothing_arrives(stub, monkeypatch):
    """A pushed source that hears nothing names where the provider must post — its OWN hub URL — because an app
    made from an older link (a deleted sibling's claim) posts elsewhere and that failure is otherwise silent."""
    from datetime import datetime, timezone

    from flow_sdk.builtin import data_source as module

    name, _ = stub
    source = DataSource(provider=name, name="bot", config={})
    await source.save()
    mine = [
        {"id": "old", "url": "https://hub/webhook/old", "claim": {"kind": "account"}, "target": {"data_source_id": "other"}},
        {"id": "own", "url": "https://hub/webhook/own", "claim": {"kind": "account"}, "target": {"data_source_id": str(source.id)}},
    ]

    async def claims():
        return mine

    monkeypatch.setattr(module, "_hub_claims", claims)
    try:
        answer = await source.step("heard", values={"since": datetime.now(timezone.utc).isoformat(), "wait": "0"})
        assert answer.exit_code is ExitCode.NOT_YET
        assert "https://hub/webhook/own" in answer.detail and "https://hub/webhook/old" not in answer.detail
    finally:
        await source.delete()


async def test_public_webhook_chains_a_part_of_an_account_under_the_accounts_claim(stub, monkeypatch):
    """A driver whose source is PART of an account (a WhatsApp group of a number) declares its claim ``under`` the
    account: the chain request's parent is the person's own account claim (the one delivering HERE first), the
    source keeps no URL of its own, and with no account claim yet it says to claim the account first."""
    from flow_sdk.builtin import data_source as ds
    from flow_sdk.instance_settings import runtime

    name, kept = stub
    driver = DataDriver.loaded(name)
    asked: list = []
    claims: list = []

    async def fake_call(method, entity_type, entity_id=None, action=None, *a, payload=None, **kw):
        assert method == "POST"
        asked.append((entity_type, action, payload))
        return {"id": "g-1"}

    async def hub_claims():
        return list(claims)

    def hub_claim(cls, config, secrets):
        return {"provider": "vendor", "kind": "group", "key": config["group"],
                "under": {"kind": "account", "key": config["app_id"]}}

    monkeypatch.setattr(HubProxy, "call", staticmethod(fake_call))
    monkeypatch.setattr(ds, "_hub_claims", hub_claims)
    monkeypatch.setattr(runtime, "instance_uid", lambda: "inst-1")
    monkeypatch.setattr(driver.cls, "hub_claim", classmethod(hub_claim), raising=False)
    source = DataSource(provider=name, name="trip", config={"app_id": "A1", "group": "G1"})

    first = await source.step("public-webhook")
    assert first.exit_code is not ExitCode.OK and "account" in first.detail and asked == []

    claims[:] = [
        {"id": "acc-orphan", "provider": "vendor", "claim": {"kind": "account", "key": "A1"}, "proven_at": 0,
         "target": {"kind": "none", "instance_id": ""}},
        {"id": "acc-elsewhere", "provider": "vendor", "claim": {"kind": "account", "key": "A1"}, "proven_at": 1,
         "target": {"kind": "desktop", "instance_id": "inst-2"}},
        {"id": "acc-here", "provider": "vendor", "claim": {"kind": "account", "key": "A1"}, "proven_at": 2,
         "target": {"kind": "desktop", "instance_id": "inst-1"}},
        {"id": "acc-other", "provider": "vendor", "claim": {"kind": "account", "key": "A2"}, "proven_at": 0,
         "target": {"kind": "desktop", "instance_id": "inst-1"}},
    ]
    answer = await source.step("public-webhook")
    ((entity, action, body),) = asked
    assert (entity, action) == ("webhook", "chain")
    assert body["parent"] == "acc-here", "under the account claim that delivers to THIS instance"

    asked.clear()
    claims[:] = [c for c in claims if c["id"] != "acc-here"]
    await source.step("public-webhook")
    assert asked[0][2]["parent"] == "acc-elsewhere", "else one that delivers somewhere — never one with no target"
    assert body["claim"] == {"kind": "group", "key": "G1"}
    assert body["target"] == {"kind": "desktop", "instance_id": "inst-1", "data_source_id": str(source.id)}
    assert kept["credentials"] == [], "a part rides its account's URL: nothing of its own to keep"
    assert answer.exit_code is ExitCode.OK


@pytest.mark.parametrize("open_to_all,sender", [(False, "972500000000"), (True, "15550002222")])
async def test_first_turn_holds_once_an_allowed_sender_spoke_and_an_answer_followed(stub, monkeypatch, open_to_all, sender):
    from types import SimpleNamespace

    from flow_sdk.builtin.source_item import SourceItem

    name, _ = stub
    rows: list = []

    async def get_all(*_a, **_kw):
        return rows

    monkeypatch.setattr(SourceItem, "get_all", get_all)
    source = DataSource(provider=name, name="bot", allowed_senders=["+972 50-000-0000"], open_to_all=open_to_all)
    item = lambda who, at: SimpleNamespace(author_external_id=who, occurred_at=at, sent_by_us=who == "15550001111", external_id=at, thread_key="conversation-1", reply_to_external_id=None)  # noqa: E731

    assert (await source.step("first-turn", check=True)).exit_code is ExitCode.NOT_YET
    rows[:] = [item("15550001111", "2026-09-28T10:00:00"), item(sender, "2026-09-28T10:01:00")]
    assert (await source.step("first-turn", check=True)).exit_code is ExitCode.NOT_YET, "no answer after the person yet"
    rows.append(item("15550001111", "2026-09-28T10:01:05"))
    assert (await source.step("first-turn", check=True)).exit_code is ExitCode.OK


async def test_the_hubs_source_nudge_wakes_the_driver_it_names(monkeypatch):
    """The hub names the driver as data (``source_nudge``) — the bridge knows no driver."""
    from flow_sdk.cloud_client import hub_bridge

    class _Manager:
        def __init__(self):
            self.handlers = {}

        def register_handler(self, kind, handler):
            self.handlers[kind] = handler

    woke: list = []

    async def nudge(provider):
        woke.append(provider)
        return 1

    monkeypatch.setattr(DataSource, "nudge", nudge)
    manager = _Manager()
    hub_bridge.HubWsBridge(manager).install()

    await manager.handlers["source_nudge"]({"message_type": "source_nudge", "driver": "some_driver"})
    await manager.handlers["source_nudge"]({"message_type": "source_nudge"})
    assert woke == ["some_driver"]


async def test_direct_callback_needs_no_hub_and_redacts_only_secrets(stub, monkeypatch):
    from flow_sdk.server import webhook_listener

    name, kept = stub
    source = DataSource(provider=name, name="direct", config={})
    driver = DataDriver.loaded(name)
    monkeypatch.setattr(driver.cls, "webhook_authentic", staticmethod(lambda *_: True), raising=False)

    async def callback_base_url(*, start=False):
        assert start
        return "http://127.0.0.1:6543"

    async def forbidden(*_a, **_kw):
        pytest.fail("direct setup must not contact the hub")

    monkeypatch.setattr(webhook_listener, "callback_base_url", callback_base_url)
    monkeypatch.setattr(HubProxy, "call", staticmethod(forbidden))
    answer = await source.step("public-webhook", values={"delivery": "direct"})
    assert answer.ok
    assert answer.value["secrets"] == {}
    assert answer.value["shown"]["link"] == f"http://127.0.0.1:6543/api/v1/data_source/webhook/{name}?source_id={source.id}"
    assert source.config["verify_token"]
    assert kept["credentials"][-1][1]["STUB_WEBHOOK_URL"] == answer.value["shown"]["link"]


async def test_direct_callback_requires_driver_authentication(stub):
    name, _ = stub
    source = DataSource(provider=name, name="unsigned", config={})
    answer = await source.step("public-webhook", values={"delivery": "direct"})
    assert answer.exit_code is ExitCode.NOT_APPLICABLE


async def test_first_turn_requires_our_reply_in_the_same_conversation(stub, monkeypatch):
    from flow_sdk.builtin.source_item import SourceItem

    name, _ = stub
    source = DataSource(provider=name, name="bot")
    rows = [SourceItem(external_id="in-1", thread_key="chat-1", author_external_id="person", occurred_at="2026-10-11T00:00:01Z")]

    async def get_all(*_a, **_kw):
        return rows

    monkeypatch.setattr(SourceItem, "get_all", get_all)
    rows.append(SourceItem(external_id="stranger", thread_key="chat-1", author_external_id="other", occurred_at="2026-10-11T00:00:02Z"))
    assert not (await source.step("first-turn", check=True)).ok
    rows.append(SourceItem(external_id="out-1", thread_key="chat-2", sent_by_us=True, occurred_at="2026-10-11T00:00:03Z"))
    assert not (await source.step("first-turn", check=True)).ok
    rows.append(SourceItem(external_id="out-2", thread_key="chat-1", sent_by_us=True, reply_to_external_id="in-1", occurred_at="2026-10-11T00:00:04Z"))
    answer = await source.step("first-turn", check=True, values={"external_id": "in-1"})
    assert answer.ok and answer.value.model_dump() == {"incoming_external_id": "in-1", "reply_external_id": "out-2"}
    assert not (await source.step("first-turn", check=True, values={"external_id": "later-test"})).ok


async def test_first_turn_since_does_not_reuse_a_historical_conversation(stub, monkeypatch):
    from flow_sdk.builtin.source_item import SourceItem

    name, _ = stub
    source = DataSource(provider=name, name="bot")
    rows = [
        SourceItem(external_id="historical-in", thread_key="chat", occurred_at="2026-10-10T12:00:00Z"),
        SourceItem(external_id="historical-out", thread_key="chat", sent_by_us=True, occurred_at="2026-10-10T12:00:01Z"),
    ]

    async def get_all(*_a, **_kw):
        return rows

    monkeypatch.setattr(SourceItem, "get_all", get_all)
    assert (await source.step("first-turn", check=True)).ok
    assert not (await source.step("first-turn", check=True, values={"since": "2026-10-11T00:00:00Z"})).ok
    rows.extend([
        SourceItem(external_id="new-in", thread_key="chat", occurred_at="2026-10-11T00:00:01Z"),
        SourceItem(external_id="new-out", thread_key="chat", sent_by_us=True, reply_to_external_id="new-in", occurred_at="2026-10-11T00:00:02Z"),
    ])
    proof = await source.step("first-turn", check=True, values={"since": "2026-10-11T00:00:00Z"})
    assert proof.ok and proof.value.incoming_external_id == "new-in"


async def test_first_turn_distinguishes_received_message_from_no_message(stub, monkeypatch):
    from flow_sdk.builtin.source_item import SourceItem

    name, _ = stub
    source = DataSource(provider=name, name="bot")
    rows = []

    async def get_all(*_a, **_kw):
        return rows

    monkeypatch.setattr(SourceItem, "get_all", get_all)
    assert (await source.step("first-turn", check=True)).detail.startswith("Send a message")
    rows.append(SourceItem(external_id="received", thread_key="phone", occurred_at="2026-10-11T21:08:48+00:00"))
    pending = await source.step("first-turn", check=True)
    assert not pending.ok and pending.detail == "Message received; waiting for the agent reply."
    rows.clear()
    assert (await source.step("first-turn", check=True)).detail.startswith("Send a message")


async def test_setup_can_set_and_revoke_public_access(stub):
    name, kept = stub
    source = DataSource(provider=name, name="public bot")
    driver = DataDriver.loaded(name)
    await source._keep(driver, SourceUpdateSpec(open_to_all=True))
    assert source.open_to_all is True
    await source._keep(driver, SourceUpdateSpec(open_to_all=False))
    assert source.open_to_all is False and kept["saves"] == 2


async def test_an_agent_shipped_in_a_system_project_keeps_its_secrets_in_the_user_scope(monkeypatch):
    """The system project is read-only shipped content — its credential folders are the templates — so a
    source owned by a shipped agent reads and writes the user scope, never collides with a template."""
    from types import SimpleNamespace

    from flow_sdk.builtin.project import Project
    from flow_sdk.ingest import credentials as ingest_credentials
    from flow_sdk.stream_inbox import projection

    projects = {"sys": SimpleNamespace(id="sys", system=True), "mine": SimpleNamespace(id="mine", system=False)}

    async def get_by_id(project_id):
        return projects.get(project_id)

    monkeypatch.setattr(Project, "get_by_id", get_by_id)
    for project_id, expected in (("sys", None), ("mine", projects["mine"])):
        async def owning_agent(_row, _pid=project_id):
            return SimpleNamespace(project_id=_pid)

        monkeypatch.setattr(projection, "owning_agent", owning_agent)
        assert await ingest_credentials.owner_project(object()) is expected
