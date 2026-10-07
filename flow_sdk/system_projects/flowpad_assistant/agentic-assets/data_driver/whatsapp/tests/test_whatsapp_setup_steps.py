"""The whatsapp-test wizard's provider steps — ``app``, ``number``, ``me``, ``subscribe`` — over a loopback
Graph that behaves like Meta's for exactly these calls: an app token authenticates as the app, a template
reaches only a test recipient (131030 otherwise), a subscription is listed once made."""
from __future__ import annotations

import json
from urllib.parse import parse_qs, urlsplit

import pytest
from pydantic import SecretStr

from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets

WhatsAppSource = asset_module("whatsapp").WhatsAppSource

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

APP, SECRET, PHONE, WABA, ME = "app1", "sec1", "555000", "waba1", "972500000000"
HOOK = "https://hub.example/api/v1/webhook/w-1"


class _Meta:
    def __init__(self):
        self.recipients: set[str] = set()
        self.subscriptions: list[dict] = []
        self.subscribed_apps: list[dict] = []
        self.sent: list[dict] = []
        #: The number's own webhook override (``webhook_configuration.override_callback_uri``).
        self.override: dict = {}

    def __call__(self, path, headers):
        url = urlsplit(path)
        route, q = url.path.split("/v23.0/", 1)[-1], {k: v[0] for k, v in parse_qs(url.query).items()}
        method, auth = headers.get("_method", "GET"), next((v for k, v in headers.items() if k.lower() == "authorization"), "")
        app_token = auth == f"Bearer {APP}|{SECRET}"

        def reply(status, body):
            return status, json.dumps(body).encode(), {"Content-Type": "application/json"}

        if route == APP:
            return reply(200, {"id": APP, "name": "My bot"}) if app_token else reply(400, {"error": {"message": "Invalid OAuth access token"}})
        if route == PHONE:
            if auth not in ("Bearer TEMP", "Bearer LONG"):
                return reply(401, {"error": {"message": "expired"}})
            if method == "POST" and "webhook_configuration" in q:
                self.override = json.loads(q["webhook_configuration"])
                return reply(200, {"success": True})
            if q.get("fields") == "webhook_configuration":
                return reply(200, {"webhook_configuration": {"phone_number": self.override.get("override_callback_uri", "")}})
            return reply(200, {"display_phone_number": "+1 555-000"})
        if route == "oauth/access_token":
            return reply(200, {"access_token": "LONG"})
        if route == f"{PHONE}/messages":
            body = json.loads(headers.get("_body") or "{}")
            if body.get("to") not in self.recipients:
                return reply(400, {"error": {"message": "(#131030) Recipient phone number not in allowed list"}})
            self.sent.append(body)
            return reply(200, {"messages": [{"id": "wamid.1"}]})
        if route == f"{APP}/subscriptions" and app_token:
            if method == "POST":
                self.subscriptions = [{"object": q["object"], "callback_url": q["callback_url"], "fields": [{"name": q["fields"]}]}]
                return reply(200, {"success": True})
            return reply(200, {"data": self.subscriptions})
        if route == f"{WABA}/subscribed_apps":
            if method == "POST":
                self.subscribed_apps = [{"whatsapp_business_api_data": {"id": APP}}]
                return reply(200, {"success": True})
            return reply(200, {"data": self.subscribed_apps})
        return reply(404, {"error": {"message": f"no route {route}"}})


@pytest.fixture
def meta():
    graph = _Meta()
    with local_http_server(graph) as base:
        graph.base = base
        yield graph


def _source(meta, config=None, **secrets) -> WhatsAppSource:
    values = {k: SecretStr(v) for k, v in secrets.items()}
    return WhatsAppSource(SourceBinding(
        config={"base_url": meta.base, **(config or {})},
        credentials=ResolvedSecrets(shape=AuthShape.SECRETS, values=values),
    ))


async def test_app_is_proven_by_authenticating_as_the_app_and_keeps_the_secret_in_the_credential(meta):
    wrong = await _source(meta)._app_step(check=False, values={"app_id": APP, "app_secret": "nope"})
    assert wrong.exit_code is ExitCode.NOT_YET and "refused" in wrong.detail

    answer = await _source(meta)._app_step(check=False, values={"app_id": APP, "app_secret": SECRET})
    assert answer.ok and "My bot" in answer.detail
    assert answer.value.config == {"app_id": APP} and answer.value.secrets == {"app_secret": SECRET}
    assert (await _source(meta, {"app_id": APP}, app_secret=SECRET)._app_step(check=True, values={})).ok


async def test_number_proves_the_token_and_trades_it_for_a_long_lived_one(meta):
    source = _source(meta, {"app_id": APP}, app_secret=SECRET)
    missing = await source._number_step(check=False, values={"phone_number_id": PHONE})
    assert missing.exit_code is ExitCode.NOT_YET and "Business Account" in missing.detail

    answer = await source._number_step(check=False, values={"phone_number_id": PHONE, "waba_id": WABA, "access_token": "TEMP"})
    assert answer.ok and "+1 555-000" in answer.detail and "extended" in answer.detail
    assert answer.value.secrets == {"access_token": "LONG"} and answer.value.config == {"phone_number_id": PHONE, "waba_id": WABA}


async def test_me_says_how_to_become_a_test_recipient_then_says_hello(meta):
    source = _source(meta, {"phone_number_id": PHONE}, access_token="LONG")
    refused = await source._me_step(check=False, values={"my_number": "+972 50-000-0000"})
    assert refused.exit_code is ExitCode.NOT_YET and "API Setup → To" in refused.detail and not meta.sent

    meta.recipients.add(ME)
    answer = await source._me_step(check=False, values={"my_number": "+972 50-000-0000"})
    assert answer.ok and meta.sent[0]["template"]["name"] == "hello_world"
    assert answer.value.allowed_senders == [ME] and answer.value.config == {"test_recipient": ME}


async def test_subscribe_points_metas_webhook_at_the_public_url_once(meta):
    config = {"app_id": APP, "waba_id": WABA, "verify_token": "tok", "phone_number_id": PHONE}
    source = _source(meta, config, app_secret=SECRET, access_token="LONG", webhook_url=HOOK)
    assert (await source._subscribe_step(check=True, values={})).exit_code is ExitCode.NOT_YET

    answer = await source._subscribe_step(check=False, values={})
    assert answer.ok and meta.override == {"override_callback_uri": HOOK, "verify_token": "tok"} and meta.subscribed_apps
    assert meta.subscriptions[0]["callback_url"] == HOOK, "a first app gets a messages webhook at all"
    again = await source._subscribe_step(check=False, values={})
    assert again.ok and again.ran is False, "already subscribed: nothing is posted again"


async def test_subscribe_never_repoints_an_apps_existing_callback(meta):
    """An app shared by several numbers (or instances): its own callback is someone's -- only THIS number's
    override moves, so the last setup cannot take every number's messages."""
    meta.subscriptions = [{"object": "whatsapp_business_account", "callback_url": "https://someone.else/hook", "fields": [{"name": "messages"}]}]
    config = {"app_id": APP, "waba_id": WABA, "verify_token": "tok", "phone_number_id": PHONE}
    source = _source(meta, config, app_secret=SECRET, access_token="LONG", webhook_url=HOOK)

    answer = await source._subscribe_step(check=False, values={})

    assert answer.ok and meta.override["override_callback_uri"] == HOOK
    assert meta.subscriptions[0]["callback_url"] == "https://someone.else/hook"


def test_the_number_is_claimed_on_the_hub_chain_only_once_its_token_and_secret_are_known():
    claim = WhatsAppSource.hub_claim({"phone_number_id": PHONE, "verify_token": "tok"}, {"access_token": "LONG", "app_secret": SECRET})
    assert claim == {"provider": "whatsapp", "key": PHONE, "proof": {"credential": "LONG", "app_secret": SECRET, "verify_token": "tok"}}
    assert WhatsAppSource.hub_claim({"phone_number_id": PHONE}, {"access_token": "LONG"}) is None


async def test_subscribe_waits_for_the_steps_before_it(meta):
    answer = await _source(meta, {"app_id": APP}, app_secret=SECRET)._subscribe_step(check=False, values={})
    assert answer.exit_code is ExitCode.NOT_YET and "public URL" in answer.detail
