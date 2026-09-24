"""The ``voice_file`` source's case in the voice matrix: a clip handed in as bytes, transcribed and
answered as a spoken clip, against a loopback OpenAI audio API (``FakeRealtime``)."""
from __future__ import annotations

import base64

from contextlib import contextmanager

from pydantic import SecretStr

from flow_sdk.external_apis.voice.testing import FakeRealtime
from flow_sdk.sources.credentials import AuthShape, Credentials

#: A 44-byte silent WAV header: bytes a clip is made of; the fake transcribes it as the utterance.
WAV = bytes.fromhex("52494646240000005741564566d7420100000001000100401f0000803e0000020010006461746100000000")


class Double:
    provider = "voice_file"
    sender = "sound-file"
    greets = False
    keeps_audio = True

    def __init__(self, *, utterance: str = "What is on my plate today?", folder: str = ""):
        self.fake = FakeRealtime(utterance=utterance)
        self.folder = folder
        self.config: dict = {}
        self.fields: dict = {}

    async def __aenter__(self) -> "Double":
        await self.fake.__aenter__()
        self.config = {"folder": self.folder, "base_url": self.fake.base_url}
        return self

    async def __aexit__(self, *exc) -> None:
        await self.fake.__aexit__(*exc)

    async def credentials(self, _row):
        return Credentials(shape=AuthShape.ENV, values={"OPENAI_API_KEY": SecretStr("sk-test")})

    def offer(self) -> dict:
        return {"audio_b64": base64.b64encode(WAV).decode(), "name": "question.wav", "caller": self.sender}

    async def ring(self, driver, row):
        source = await driver.open(row)
        async with source:
            answer, call = await source.start_call(self.offer())
        assert answer["clip"].endswith("question.wav"), answer
        return call


@contextmanager
def case(monkeypatch, tmp_path):
    """The data source matrix case: a send is a spoken clip under ``out/`` (a loopback speech API)."""
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
    from flow_sdk.ingest.testing import local_http_server  # noqa: PLC0415

    def speech(path, headers):
        return 200, b"ID3matrix", {"Content-Type": "audio/mpeg"}

    async def credentials(_row):
        return Credentials(shape=AuthShape.ENV, values={"OPENAI_API_KEY": SecretStr("sk-test")})

    monkeypatch.setattr(DataDriver.loaded("voice_file"), "credentials_for", credentials)
    with local_http_server(speech) as base:
        folder = tmp_path / "voice-clips"
        yield {"config": {"folder": str(folder), "base_url": base + "/v1"}, "fields": {}, "min_items": 0,
               "send": {"to": "sound-file", "text": "matrix send"}, "folder": folder}
