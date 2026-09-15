"""The data source matrix, CLI surface: every shipped data source × every verb, through ``flow source``.

The same cases as the REST matrix (each asset folder's ``tests/matrix.py``), driven through the real
typer commands. The command's HTTP calls are bridged into the in-process app — the one thing a CLI
run against a live server has that a test cannot — so the envelope parsing, the option shapes and
the exit codes are the command's own.
"""
from __future__ import annotations

import asyncio
import json

import pytest
from typer.testing import CliRunner

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.cli.commands import source_cmd
from flow_sdk.ingest.source_registry import SHIPPED_ROOT, load_module
from flow_sdk.ingest.sources import source_type
from tests.api.test_source_matrix import NAMES, _spec_row

pytestmark = pytest.mark.asyncio


class _Response:
    def __init__(self, response):
        self.status_code, self.text, self._response = response.status_code, response.text, response

    def json(self):
        return self._response.json()


def _bridge(monkeypatch, client, loop):
    def path_of(url: str) -> str:
        return "/" + url.split("://", 1)[1].split("/", 1)[1]

    def post(url, json=None, timeout=None, **_kw):
        return _Response(asyncio.run_coroutine_threadsafe(client.post(path_of(url), json=json), loop).result())

    def get(url, timeout=None, **_kw):
        return _Response(asyncio.run_coroutine_threadsafe(client.get(path_of(url)), loop).result())

    monkeypatch.setattr(source_cmd, "_discover_port", lambda *a, **k: 1)
    monkeypatch.setattr(source_cmd, "_local_post", post)
    monkeypatch.setattr(source_cmd, "_local_get", get)


async def _flow(*args: str) -> dict:
    result = await asyncio.to_thread(CliRunner().invoke, source_cmd.source_app, list(args))
    assert result.exit_code == 0, f"flow source {' '.join(args)} → exit {result.exit_code}: {result.output[-800:]}"
    return json.loads(result.stdout.strip().splitlines()[-1] if "\n" in result.stdout.strip() else result.stdout)


def _config_args(config: dict) -> list[str]:
    args: list[str] = []
    for key, value in config.items():
        args += ["--config", f"{key}={chr(10).join(map(str, value)) if isinstance(value, list) else value}"]
    return args


async def test_types_and_list_answer(client, monkeypatch):
    _bridge(monkeypatch, client, asyncio.get_running_loop())
    listed = await _flow("list")
    assert isinstance(listed["sources"], list)
    await _flow("types")


@pytest.mark.parametrize("name", NAMES)
async def test_the_source_works_through_the_cli(name, client, monkeypatch, tmp_path):
    stype = source_type(name)
    _bridge(monkeypatch, client, asyncio.get_running_loop())

    async def _ready(self):
        return True

    monkeypatch.setattr(DataSource, "capabilities_ready", _ready)
    await _spec_row(name)
    cases = load_module(SHIPPED_ROOT / name / "tests", "matrix")

    with cases.case(monkeypatch, tmp_path) as case:
        fields = case.get("fields", {})
        options = [f"--{k.replace('_', '-')}={v}" for k, v in fields.items()]
        created = (await _flow("create", name, "--name", f"cli matrix {name}", *_config_args(case["config"]), *options))["source"]
        source_id = created["id"]

        assert "ready" in (await _flow("verify", source_id))["verdict"]
        if case.get("push"):
            await client.post(f"/api/v1/data_source/webhook/{name}", json=case["push"])

        report = (await _flow("sync", source_id))["report"]
        assert report["health"] == "ok", f"{name}: {report}"
        if case.get("after_first_sync"):
            case["after_first_sync"]()
            assert (await _flow("sync", source_id))["report"]["health"] == "ok"

        items = (await _flow("items", source_id, "--limit", "50"))["items"]
        assert len(items) >= case.get("min_items", 0), f"{name}: {len(items)} items"

        if stype.sends:
            send = case["send"]
            args = ["send", source_id, "--to", send["to"], "--text", send["text"]]
            args += ["--thread", send["thread_key"]] if send.get("thread_key") else []
            args += ["--subject", send["subject"]] if send.get("subject") else []
            sent = (await _flow(*args))["sent"]
            assert sent["status"] in ("sent", "drafted") and sent["external_id"], sent
            inbound = [i for i in items if i.get("external_id") != sent["external_id"]]
            if inbound:
                assert (await _flow("reply", source_id, inbound[-1]["id"], "--text", "cli matrix reply"))["sent"]["external_id"]

        assert (await _flow("disable", source_id))["status"] == "disabled"
        assert (await _flow("enable", source_id))["status"] == "active"
        await _flow("delete", source_id)
        assert await DataSource.get_one({"id": source_id}) is None
