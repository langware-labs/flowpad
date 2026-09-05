"""POST /api/v1/display/url — the deep link behind `flow record url`.

Two things prose cannot enforce and a manual check would never notice:

* the route is **side-effect free** — it must not run the recovery path that
  parses and ``sync_to_db``s an unindexed file, because a query must not index;
* each refusal carries its own ``error_code``, since the CLI branches on that
  and not on the HTTP status (``ApiFailResponse.status_code`` is a body field,
  so every one of these arrives as HTTP 200).
"""

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = pytest.mark.asyncio


async def _post(client, body: dict):
    resp = await client.post("/api/v1/display/url", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _error_code(payload: dict) -> str:
    assert payload["status"] != "SUCCESS", payload
    return (payload.get("data") or {}).get("error_code")


async def test_indexed_markdown_resolves_to_its_editor_url(client, tmp_path):
    """The tagit case: a doc that has been indexed gets a clickable link."""
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    doc = tmp_path / "catchup-login.md"
    doc.write_text("---\ntitle: Catchup login\ntags: [breadcrumb.test.catchup_login.rules]\n---\n# Catchup login\n")

    records = SchemaRegistry.get("markdown").from_disk_fn(FSRef(doc), "")
    assert records, "doc should parse"
    entity = await Entity.from_record(records[0])
    assert entity is not None

    payload = await _post(client, {"path": str(doc)})
    assert payload["status"] == "SUCCESS", payload
    data = payload["data"]

    assert data["type"] == "markdown"
    assert data["editor"] == "markdown"
    assert data["typeid"] == f"markdown-{entity.id}"
    # Built against the UI port, which is NOT the API port in a dev instance.
    assert data["url"] == (
        f"http://localhost:{get_instance_settings().ui_port}"
        f"/dock/assets/editor/markdown/typeid/markdown-{entity.id}"
    )


async def test_the_same_record_resolves_by_typeid(client, tmp_path):
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415

    doc = tmp_path / "by-typeid.md"
    doc.write_text("---\ntitle: By typeid\n---\n# By typeid\n")
    entity = await Entity.from_record(SchemaRegistry.get("markdown").from_disk_fn(FSRef(doc), "")[0])

    data = (await _post(client, {"typeid": f"markdown-{entity.id}"}))["data"]
    assert data["url"].endswith(f"/dock/assets/editor/markdown/typeid/markdown-{entity.id}")


async def test_an_unindexed_file_is_reported_not_indexed_and_never_indexed(client, tmp_path, monkeypatch):
    """The guarantee that keeps this a query.

    ``resolve_display_target``'s recovery branch parses the file and syncs it
    to the DB. That is right for `flow show` and wrong here, so the route asks
    for ``discover=False``. Patching the recovery to explode proves the branch
    is not merely unlikely — it is unreachable.

    The fixture has to sit under ``docs/``: ``SchemaRegistry.type_for`` names a
    record type for markdown it can place, so a bare ``tmp_path/*.md`` never
    reaches the recovery branch at all and would make this test vacuous. That
    is also the real tagit path — ``docs/breadcrumbs/<slug>.md``.
    """
    import flow_sdk.builtin.faas.fs_records_actions as fs_records_actions  # noqa: PLC0415

    def _boom(*args, **kwargs):
        raise AssertionError("display/url must not index: it called discover_record_by_path")

    monkeypatch.setattr(fs_records_actions, "discover_record_by_path", _boom)

    docs = tmp_path / "docs" / "breadcrumbs"
    docs.mkdir(parents=True)
    doc = docs / "never-indexed.md"
    doc.write_text("---\ntitle: Fresh\n---\n# Fresh\n")

    payload = await _post(client, {"path": str(doc)})
    assert _error_code(payload) == "NOT_INDEXED"
    assert "flow record index" in payload["message"]


async def test_a_type_with_no_asset_editor_says_so(client):
    """A shell is not a document. Say that, rather than invent a URL segment."""
    from flow_sdk.builtin.shell import Shell  # noqa: PLC0415

    shell = Shell(name="Terminal", workdir="/tmp")
    await shell.save()

    payload = await _post(client, {"typeid": f"shell-{shell.id}"})
    assert _error_code(payload) == "NO_ASSET_EDITOR"


async def test_missing_entity_and_malformed_input_are_distinguishable(client):
    assert _error_code(await _post(client, {})) == "INVALID_ARG"
    assert _error_code(await _post(client, {"typeid": "not-a-typeid"})) == "INVALID_ARG"
    assert (
        _error_code(await _post(client, {"typeid": "markdown-550e8400-e29b-41d4-a716-446655440000"}))
        == "NOT_FOUND"
    )
