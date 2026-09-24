"""The ``voice_browser`` source's case in the voice matrix: a browser's offer, answered by a loopback
OpenAI Realtime (``FakeRealtime``) that plays one caller through the real SDK."""
from __future__ import annotations

from contextlib import contextmanager

from pydantic import SecretStr

from flow_sdk.external_apis.voice.testing import FakeRealtime
from flow_sdk.sources.credentials import AuthShape, Credentials


class Double:
    provider = "voice_browser"
    #: Who is at the browser.
    sender = "ada@local.test"
    #: The voice greets on a live line before anyone speaks.
    greets = True
    keeps_audio = False

    def __init__(self, *, utterance: str = "What is on my plate today?"):
        self.fake = FakeRealtime(utterance=utterance)
        self.config: dict = {}
        self.fields: dict = {}

    async def __aenter__(self) -> "Double":
        await self.fake.__aenter__()
        self.config = {"room": "desk", "base_url": self.fake.base_url}
        return self

    async def __aexit__(self, *exc) -> None:
        await self.fake.__aexit__(*exc)

    async def credentials(self, _row):
        return Credentials(shape=AuthShape.ENV, values={"OPENAI_API_KEY": SecretStr("sk-test")})

    def offer(self) -> dict:
        """What the browser posts to start a call."""
        return {"sdp": "v=0\r\ns=browser-offer\r\n", "caller": self.sender, "caller_name": "Ada"}

    async def ring(self, driver, row):
        """A call on the line, the way the route starts one: the source's ``start_call``."""
        source = await driver.open(row)
        async with source:
            answer, call = await source.start_call(self.offer())
        assert answer["sdp"].startswith("v=0"), answer
        return call


@contextmanager
def case(monkeypatch, tmp_path):
    """The data source matrix case: a line nobody is on — a send is a draft, honestly reported."""
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    async def credentials(_row):
        return Credentials(shape=AuthShape.ENV, values={"OPENAI_API_KEY": SecretStr("sk-test")})

    monkeypatch.setattr(DataDriver.loaded("voice_browser"), "credentials_for", credentials)
    yield {"config": {"room": "matrix-desk"}, "fields": {}, "min_items": 0, "send": {"to": "ada@local.test", "text": "matrix send"}}
