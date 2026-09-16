"""The data source matrix scenario, written once and driven through each surface.

Every shipped data source × create · verify · (handshake · push) · sync · items · send · reply ·
disable · enable · delete. Each source's provider is doubled by the source itself: its asset
folder's ``tests/matrix.py`` yields the config, the doubles and the expectations. A driver is the
surface — REST (the seam the CLI, the TS SDK and the UI share) or the ``flow source`` CLI — and the
scenario cannot tell them apart. This file names no source.
"""
from __future__ import annotations

import asyncio
import json

from typer.testing import CliRunner

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.data_driver_spec import DataDriverSpec
from flow_sdk.cli.commands import _common, source_cmd
from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, load_module, read_manifest
from flow_sdk.ingest.driver_types import driver_type

NAMES = sorted(p.name for p in SHIPPED_ROOT.iterdir() if (p / "data_driver.json").is_file())


async def spec_row(name: str) -> None:
    """The manifest as its spec row — what the indexer writes on an instance — so config coercion
    and the reflect-mode rule run as they do there."""
    if await DataDriverSpec.get_one({"name": name}) is None:
        manifest = read_manifest(SHIPPED_ROOT / name)
        await DataDriverSpec(**manifest.model_dump(by_alias=False, exclude={"manifest_schema"})).save(notify=False)


def _data(response) -> dict:
    body = response.json()
    assert response.status_code == 200 and body.get("status") == "SUCCESS", f"{response.status_code}: {json.dumps(body)[:600]}"
    return body.get("data") if isinstance(body.get("data"), (dict, list)) else {}


class RestDriver:
    def __init__(self, client):
        self.client = client

    async def _action(self, source_id: str, verb: str, payload: dict | None = None) -> dict:
        return _data(await self.client.post(f"/api/v1/graph/data_source/{source_id}/{verb}", json=payload or {}))

    async def create(self, name: str, config: dict, fields: dict) -> str:
        return _data(await self.client.post("/api/v1/graph/data_source", json={"name": f"matrix {name}", "provider": name, "config": config, **fields}))["id"]

    async def verify(self, source_id: str) -> dict:
        return await self._action(source_id, "verify")

    async def sync(self, source_id: str) -> dict:
        return await self._action(source_id, "sync")

    async def items(self, source_id: str) -> list:
        return (await self._action(source_id, "items", {"limit": 50}))["items"]

    async def send(self, source_id: str, message: dict) -> dict:
        return await self._action(source_id, "send", message)

    async def reply(self, source_id: str, item_id: str, text: str) -> dict:
        return await self._action(source_id, "reply", {"item_id": item_id, "text": text})

    async def set_enabled(self, source_id: str, enabled: bool) -> str:
        return (await self._action(source_id, "set_enabled", {"enabled": enabled}))["status"]

    async def delete(self, source_id: str) -> None:
        _data(await self.client.delete(f"/api/v1/graph/data_source/{source_id}"))


class CliDriver:
    """``flow source`` through the real typer commands, their HTTP bridged into the in-process app."""

    def __init__(self, client, monkeypatch):
        loop = asyncio.get_running_loop()

        def request(method, url, json=None, timeout=None, **_kw):
            path = "/" + url.split("://", 1)[1].split("/", 1)[1]
            return asyncio.run_coroutine_threadsafe(client.request(method, path, json=json), loop).result()

        monkeypatch.setattr(source_cmd, "discover_port", lambda *a, **k: 1)
        monkeypatch.setattr(_common, "local_request", request)

    @staticmethod
    async def flow(*args: str) -> dict:
        result = await asyncio.to_thread(CliRunner().invoke, source_cmd.source_app, list(args))
        assert result.exit_code == 0, f"flow source {' '.join(args)} → exit {result.exit_code}: {result.output[-800:]}"
        return json.loads(result.stdout.strip().splitlines()[-1])

    async def create(self, name: str, config: dict, fields: dict) -> str:
        args = [arg for key, value in config.items() for arg in ("--config", f"{key}={chr(10).join(map(str, value)) if isinstance(value, list) else value}")]
        args += [f"--{key.replace('_', '-')}={value}" for key, value in fields.items()]
        return (await self.flow("create", name, "--name", f"cli matrix {name}", *args))["source"]["id"]

    async def verify(self, source_id: str) -> dict:
        return (await self.flow("verify", source_id))["verdict"]

    async def sync(self, source_id: str) -> dict:
        return (await self.flow("sync", source_id))["report"]

    async def items(self, source_id: str) -> list:
        return (await self.flow("items", source_id, "--limit", "50"))["items"]

    async def send(self, source_id: str, message: dict) -> dict:
        args = ["send", source_id, "--to", message["to"], "--text", message["text"]]
        args += ["--thread", message["thread_key"]] if message.get("thread_key") else []
        args += ["--subject", message["subject"]] if message.get("subject") else []
        return (await self.flow(*args))["sent"]

    async def reply(self, source_id: str, item_id: str, text: str) -> dict:
        return (await self.flow("reply", source_id, item_id, "--text", text))["sent"]

    async def set_enabled(self, source_id: str, enabled: bool) -> str:
        return (await self.flow("enable" if enabled else "disable", source_id))["status"]

    async def delete(self, source_id: str) -> None:
        await self.flow("delete", source_id)


async def run_case(name: str, driver, client, monkeypatch, tmp_path) -> None:
    stype = driver_type(name)
    assert stype is not None and stype.manifest is not None, f"{name} did not load"
    await spec_row(name)
    cases = load_module(SHIPPED_ROOT / name / "tests", "matrix")

    with cases.case(monkeypatch, tmp_path) as case:
        source_id = await driver.create(name, case["config"], case.get("fields", {}))
        assert "ready" in await driver.verify(source_id)

        if case.get("handshake"):
            answer = await client.get(f"/api/v1/data_source/webhook/{name}", params=case["handshake"])
            assert answer.status_code == 200 and answer.text == case["handshake"]["hub.challenge"], answer.text
        if case.get("push"):
            # Sent as the exact bytes the case signs, since a provider's signature covers the raw body.
            raw = json.dumps(case["push"]).encode()
            headers = {"Content-Type": "application/json", **(case["sign"](raw) if case.get("sign") else {})}
            pushed = _data(await client.post(f"/api/v1/data_source/webhook/{name}", content=raw, headers=headers))
            assert pushed.get("ingested", 0) >= 1, pushed

        report = await driver.sync(source_id)
        assert report["health"] == "ok", f"{name} sync: {report}"

        items = await driver.items(source_id)
        assert len(items) >= case.get("min_items", 0), f"{name}: {len(items)} items after sync"

        if stype.sends:
            assert case.get("send"), f"{name} sends but its matrix case names no send"
            sent = await driver.send(source_id, case["send"])
            assert sent["status"] in ("sent", "drafted") and sent["external_id"], sent
            inbound = [i for i in items if i.get("external_id") != sent["external_id"]]
            if inbound:
                assert (await driver.reply(source_id, inbound[-1]["id"], "matrix reply"))["external_id"]

        assert await driver.set_enabled(source_id, False) == "disabled"
        assert await driver.set_enabled(source_id, True) == "active"
        await driver.delete(source_id)
        assert await DataSource.get_one({"id": source_id}) is None
