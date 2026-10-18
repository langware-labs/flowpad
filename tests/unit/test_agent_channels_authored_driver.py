"""An agent's channel on a project's OWN driver is a channel in a process that never loaded it.

A local deployment is its own process (``python <file>``). Its first question is
``agent.channels()``, and a project-authored driver registers only when something asks for
it by name — shipped drivers are scanned eagerly, authored ones are not. Before the fix the
deployment's registry held no ``slack_token`` (the Q project's Slack bot driver), so its
channel failed ``is_message_source`` and the deployment answered nothing on it.

The registry is process-global: dropping the authored entry is the state a fresh
deployment process starts in, with the rows already saved by the app.
"""
from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.driver_registry import read_manifest
from flow_sdk.ingest.driver_runtime import DRIVERS

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval

SOURCE = '''
from flow_sdk.sources.config import SourceConfig
from tests.utils.fake_source import ScriptedSource


class AuthoredChatConfig(SourceConfig):
    pass


class AuthoredChatSource(ScriptedSource):
    Config = AuthoredChatConfig
    provider = "{name}"
'''


async def _authored_driver(root, name: str) -> DataDriver:
    """A project's message driver: its folder, and the row the indexer writes for it."""
    folder = root / "agentic-assets" / "data_driver" / name
    folder.mkdir(parents=True)
    (folder / "data_driver.json").write_text(
        json.dumps({"schema": 1, "name": name, "ns": "acme", "title": "Authored chat"}), encoding="utf-8"
    )
    (folder / "source.py").write_text(SOURCE.format(name=name), encoding="utf-8")
    await DataDriver(**read_manifest(folder).model_dump(exclude_none=True), asset_ref=str(folder)).save()
    return await DataDriver.get(name)


async def test_a_channel_on_an_authored_driver_survives_a_fresh_process(tmp_path):
    name = f"authored_chat_{uuid.uuid4().hex[:8]}"
    driver = await _authored_driver(tmp_path, name)
    agent = Agent(name=f"authored-owner-{name}")
    await agent.save()
    source = driver.create_source(driver.create_config(), name=f"{name} channel", owner=agent)
    await source.save()
    try:
        DRIVERS.unregister(name)  # the deployment's own process: nothing has asked for this driver yet

        assert [str(s.id) for s in await agent.channels()] == [str(source.id)]
    finally:
        DRIVERS.unregister(name)
