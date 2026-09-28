"""LIVE: the WAHA driver's outbound files, quote and reactions, against a real WAHA container.

Outbound only, by design: WAHA holds ONE webhook per session and something else may be listening on
it, so this never verifies the source (verifying re-points the webhook). It sends a probe, then a photo
whose caption is the body quoting the probe and a document, then reacts 👍 on the photo and takes it
back — the recipient sees all of it in their chat with the WAHA number.

Needs the WAHA connector installed (it is an external connector — the `waha` project), and (skips otherwise):
- ``DEEP_TESTING`` on,
- ``WAHA_BASE_URL`` / ``WAHA_API_KEY`` — the container and its key,
- ``WAHA_LIVE_TO`` — the recipient's number, digits only, given at run time (never committed; a
  personal number only with its owner's say-so for that run).
"""
from __future__ import annotations

import os
import uuid

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets
from flow_sdk.sources.files import local_file
from tests.long_tests.test_telegram_send import _png
from tests.test_settings import test_service_config

BASE_URL = os.environ.get("WAHA_BASE_URL", "")
API_KEY = os.environ.get("WAHA_API_KEY", "")
TO = "".join(ch for ch in os.environ.get("WAHA_LIVE_TO", "") if ch.isdigit())

pytestmark = [
    pytest.mark.skipif(not test_service_config.deep_testing, reason="Skipping long tests when DEEP_TESTING is disabled"),
    pytest.mark.skipif(not (BASE_URL and API_KEY), reason="set WAHA_BASE_URL and WAHA_API_KEY"),
    pytest.mark.skipif(not TO, reason="set WAHA_LIVE_TO (the recipient's number, at run time)"),
]


@pytest.fixture(autouse=True)
def _credentials(monkeypatch):
    async def credentials(_row):
        return ResolvedSecrets(shape=AuthShape.SECRETS, values={"api_key": SecretStr(API_KEY), "base_url": SecretStr(BASE_URL)})

    monkeypatch.setattr(DataDriver.loaded("waha"), "credentials_for", credentials)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_waha_sends_files_quotes_and_reacts_live(tmp_path):
    marker = f"waha-files-{uuid.uuid4().hex[:8]}"
    source = DataSource(name=f"WAHA files test {marker}", provider="waha", config={"session": "default"}, allowed_senders=[])
    await source.save()
    driver = DataDriver.loaded("waha")

    probe = await driver.send(source, thread_key="", to=TO, text=f"flowpad probe {marker}")
    photo = tmp_path / f"{marker}.png"
    photo.write_bytes(_png())
    doc = tmp_path / f"{marker}.txt"
    doc.write_text("a document from the WAHA files leg\n")

    sent = await driver.send(
        source, thread_key="", to=TO, text=f"photo {marker}", in_reply_to=probe.external_id,
        files=(local_file(photo), local_file(doc)),
    )
    assert len(sent.parts) == 2, "one WhatsApp message per file"
    first = await SourceItem.get_one({"data_source_id": source.id, "external_id": sent.parts[0]})
    assert first is not None and f"photo {marker}" in (first.body or ""), "the body rode as the photo's caption"

    await driver.react(source, first.origin, "👍")
    await driver.react(source, first.origin, "", remove=True)
