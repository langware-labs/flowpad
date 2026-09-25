"""The ``voice_phone`` source's case in the voice matrix: the agent dials (a loopback Twilio records
it), OpenAI rings back by a signed webhook, and a loopback OpenAI Realtime plays the callee."""
from __future__ import annotations

import base64
import json
from contextlib import contextmanager
from urllib.parse import parse_qsl, unquote
from xml.sax.saxutils import unescape

from pydantic import SecretStr

from flow_sdk.external_apis.voice.testing import FakeRealtime, incoming_call, sign
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources.credentials import AuthShape, Credentials

NUMBER = "+14155550100"
SECRET = "whsec_" + base64.b64encode(b"voice-matrix-webhook-secret").decode()


class Double:
    provider = "voice_phone"
    #: The person the agent calls.
    sender = "+972501234567"
    greets = True
    keeps_audio = False

    def __init__(self, *, utterance: str = "What is on my plate today?"):
        self.fake = FakeRealtime(utterance=utterance)
        self.config: dict = {}
        self.fields: dict = {}
        self.dials: list[dict] = []
        self._twilio = None

    async def __aenter__(self) -> "Double":
        await self.fake.__aenter__()
        self._twilio = local_http_server(self._carrier)
        twilio = self._twilio.__enter__()
        self.config = {"number": NUMBER, "project": "proj_matrix", "base_url": self.fake.base_url, "twilio_base_url": twilio}
        return self

    async def __aexit__(self, *exc) -> None:
        if self._twilio is not None:
            self._twilio.__exit__(*exc)
        await self.fake.__aexit__(*exc)

    async def credentials(self, _row):
        return Credentials(shape=AuthShape.ENV, values={
            "OPENAI_API_KEY": SecretStr("sk-test"), "OPENAI_WEBHOOK_SECRET": SecretStr(SECRET),
            "TWILIO_ACCOUNT_SID": SecretStr("AC" + "0" * 32), "TWILIO_AUTH_TOKEN": SecretStr("twilio-token"),
        })

    def offer(self) -> dict:
        return {"to": self.sender, "brief": "Confirm tomorrow's delivery window."}

    def _carrier(self, path: str, headers: dict):
        """Twilio: a number lookup (``verify``) lists the line's number; anything else is a dial, recorded."""
        if "/IncomingPhoneNumbers.json" in path:
            listed = [{"phone_number": NUMBER, "sid": "PN" + "0" * 32}] if NUMBER in unquote(path) else []
            return 200, json.dumps({"incoming_phone_numbers": listed}).encode(), {"Content-Type": "application/json"}
        self.dials.append({"path": path, **dict(parse_qsl(str(headers.get("_body", ""))))})
        return 201, json.dumps({"sid": f"CA{len(self.dials):032d}", "status": "queued"}).encode(), {"Content-Type": "application/json"}

    def rings_back(self, call_id: str = "") -> dict:
        """OpenAI's signed ``realtime.call.incoming`` for the dialled call: our number calling out.
        Each call its own id, as OpenAI mints one per call (``rtc_phone<n>``, n = the dial it answers)."""
        call_id = call_id or f"rtc_phone{len(self.dials)}"
        # The leg carries the X- params of the TwiML the dial handed Twilio — our dial's token among them.
        twiml = unescape(self.dials[-1].get("Twiml", "")) if self.dials else ""
        sip_params = dict(parse_qsl(twiml.split("?", 1)[1].split("<", 1)[0])) if "?" in twiml else {}
        extra = {k: v for k, v in sip_params.items() if k.startswith("X-") and k != "X-Flow-Number"}
        raw = json.dumps(incoming_call(call_id, caller=NUMBER, dialled="proj_matrix",
                                       number_header=f"sip:{NUMBER}@pstn.twilio.com", extra_headers=extra)).encode()
        return {"path": "/api/v1/data_source/webhook/voice_phone", "body": raw, "headers": sign(raw, SECRET)}

    async def ring(self, driver, row):
        """The agent dials; the callee answers; OpenAI rings us back through the webhook's chokepoint."""
        source = await driver.open(row)
        async with source:
            placed, call = await source.start_call(self.offer())
        assert call is None and placed["call_sid"], placed
        return await self.ring_back(driver, row)

    async def ring_back(self, driver, row, delivery: "dict | None" = None):
        """OpenAI's signed ring (the dialled call's, unless *delivery* names another) through the webhook's
        chokepoint: the call it carries."""
        delivery = delivery or self.rings_back()
        result = await driver.ingest_pushed(row, json.loads(delivery["body"]), headers=delivery["headers"], raw=delivery["body"])
        (call,) = result["calls"]
        return call

    def calls_in(self, caller: str, call_id: str = "rtc_in1") -> dict:
        """OpenAI's signed ring for a call *caller* places to our number."""
        raw = json.dumps(incoming_call(call_id, caller=caller, dialled="proj_matrix",
                                       number_header=f"sip:{NUMBER}@pstn.twilio.com")).encode()
        return {"body": raw, "headers": sign(raw, SECRET)}


@contextmanager
def case(monkeypatch, tmp_path):
    """The data source matrix case: a send places a call (a loopback Twilio takes it)."""
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    dials: list[dict] = []

    def carrier(path, headers):
        dials.append({"path": path})
        return 201, json.dumps({"sid": f"CA{len(dials):032d}", "status": "queued"}).encode(), {"Content-Type": "application/json"}

    async def credentials(_row):
        return Credentials(shape=AuthShape.ENV, values={
            "OPENAI_API_KEY": SecretStr("sk-test"), "OPENAI_WEBHOOK_SECRET": SecretStr(SECRET),
            "TWILIO_ACCOUNT_SID": SecretStr("AC" + "0" * 32), "TWILIO_AUTH_TOKEN": SecretStr("twilio-token"),
        })

    monkeypatch.setattr(DataDriver.loaded("voice_phone"), "credentials_for", credentials)
    with local_http_server(carrier) as twilio:
        yield {"config": {"number": NUMBER, "project": "proj_matrix", "twilio_base_url": twilio}, "fields": {},
               "min_items": 0, "send": {"to": "+972501234567", "text": "matrix send"}, "dials": dials}
