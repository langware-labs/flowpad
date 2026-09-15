"""The data source matrix, automated tier: every shipped data source × every verb, over REST.

REST is the seam the three surfaces share — the ``flow source`` CLI, the TS SDK's ``DataSource`` and
the Data Sources screen all call these actions — so a cell green here is green for each of them at
the wire. Each source's provider is doubled by the source itself: its asset folder's
``tests/matrix.py`` yields the config, the doubles and the expectations. This file names no source.

Verbs: create · verify · (push) · sync · items · send · reply · disable · delete. A source that
cannot send has no send/reply cell; a reflecting source lands files, not records.
"""
from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.data_source_spec import DataSourceSpec
from flow_sdk.ingest.source_registry import SHIPPED_ROOT, load_module, read_manifest
from flow_sdk.ingest.sources import source_type

pytestmark = pytest.mark.asyncio

NAMES = sorted(p.name for p in SHIPPED_ROOT.iterdir() if (p / "data_source.json").is_file())


def test_every_shipped_source_has_a_matrix_case():
    missing = [name for name in NAMES if not (SHIPPED_ROOT / name / "tests" / "matrix.py").is_file()]
    assert not missing, f"data sources with no tests/matrix.py case: {missing}"


async def _ok(response) -> dict:
    body = response.json()
    assert response.status_code == 200 and body.get("status") == "SUCCESS", f"{response.status_code}: {json.dumps(body)[:600]}"
    return body.get("data") if isinstance(body.get("data"), (dict, list)) else {}


async def _action(client, source_id: str, verb: str, payload: dict | None = None) -> dict:
    return await _ok(await client.post(f"/api/v1/graph/data_source/{source_id}/{verb}", json=payload or {}))


async def _spec_row(name: str) -> None:
    """The manifest as its spec row — what the indexer writes on an instance — so config coercion
    and the reflect-mode rule run as they do there."""
    if await DataSourceSpec.get_one({"name": name}) is None:
        manifest = read_manifest(SHIPPED_ROOT / name)
        await DataSourceSpec(**manifest.model_dump(by_alias=False, exclude={"manifest_schema"})).save(notify=False)


@pytest.mark.parametrize("name", NAMES)
async def test_the_source_works_end_to_end(name, client, monkeypatch, tmp_path):
    stype = source_type(name)
    assert stype is not None and not stype.manifest is None, f"{name} did not load"

    # The connection probe asks the machine's connection store; every provider here is doubled.
    async def _ready(self):
        return True

    monkeypatch.setattr(DataSource, "capabilities_ready", _ready)
    await _spec_row(name)
    cases = load_module(SHIPPED_ROOT / name / "tests", "matrix")

    with cases.case(monkeypatch, tmp_path) as case:
        created = await _ok(await client.post(
            "/api/v1/graph/data_source",
            json={"name": f"matrix {name}", "provider": name, "config": case["config"], **case.get("fields", {})},
        ))
        source_id = created["id"]

        verdict = await _action(client, source_id, "verify")
        assert "ready" in verdict, verdict

        if case.get("handshake"):
            answer = await client.get(f"/api/v1/data_source/webhook/{name}", params=case["handshake"])
            assert answer.status_code == 200 and answer.text == case["handshake"]["hub.challenge"], answer.text
        if case.get("push"):
            pushed = await _ok(await client.post(f"/api/v1/data_source/webhook/{name}", json=case["push"]))
            assert pushed.get("ingested", 0) >= 1, pushed

        report = await _action(client, source_id, "sync")
        assert report["health"] == "ok", f"{name} sync: {report}"
        if case.get("after_first_sync"):
            # A source that positions at its provider's tip on the first pass reads what arrives next.
            case["after_first_sync"]()
            report = await _action(client, source_id, "sync")
            assert report["health"] == "ok", f"{name} second sync: {report}"

        items = (await _action(client, source_id, "items", {"limit": 50}))["items"]
        assert len(items) >= case.get("min_items", 0), f"{name}: {len(items)} items after sync"

        if stype.sends:
            assert case.get("send"), f"{name} sends but its matrix case names no send"
            sent = await _action(client, source_id, "send", case["send"])
            assert sent["status"] in ("sent", "drafted") and sent["external_id"], sent
            inbound = [i for i in items if i.get("external_id") != sent["external_id"]]
            if inbound:
                replied = await _action(client, source_id, "reply", {"item_id": inbound[-1]["id"], "text": "matrix reply"})
                assert replied["external_id"], replied

        assert (await _action(client, source_id, "set_enabled", {"enabled": False}))["status"] == "disabled"
        assert (await _action(client, source_id, "set_enabled", {"enabled": True}))["status"] == "active"
        await _action(client, source_id, "remove")
        assert await DataSource.get_one({"id": source_id}) is None
