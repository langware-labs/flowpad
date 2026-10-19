"""What a caller may name, and what only the walk can know.

``resolve_asset`` is reachable from a client route (``?type=`` on the
fs-records index, ``GET /assets/resolve``). A FRAGMENT type — mcp_server,
claude_hook, plugin — is refused however it was named: all three declare
``File(".json")`` so ``claims`` cannot tell them apart from any settings file,
and all three key their id off the walk ref (``json_path``, scope), so an id
resolved from a bare path is a DIFFERENT v5 than the walk's — a second row for
the same asset.

A WHOLE-FILE type may be named, and has to be: the session transcripts share
``.jsonl`` with each other, so the registry classifies them to nothing from a
bare path, and the targeted index exists to index exactly those.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.resolve import NotAnAsset, resolve_asset
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.fixtures.identity import resolve_id

pytestmark = pytest.mark.timeout(30)

SETTINGS = {"mcpServers": {"crm": {"command": "node", "args": ["s.js"]}}}


def _settings(tmp_path: Path) -> Path:
    path = tmp_path / ".claude" / "settings.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(SETTINGS), encoding="utf-8")
    return path


@pytest.mark.asyncio
@pytest.mark.parametrize("type_name", ["mcp_server", "claude_hook", "plugin"])
async def test_a_client_named_bespoke_type_is_refused(tmp_path: Path, type_name: str) -> None:
    """``?type=mcp_server`` on a settings.json answers nothing and mints nothing."""
    path = _settings(tmp_path)
    before = path.read_bytes()

    with pytest.raises(NotAnAsset):
        await resolve_asset(path, write=True, type_name=type_name)

    assert path.read_bytes() == before


@pytest.mark.asyncio
async def test_a_json_no_type_claims_is_not_an_asset(tmp_path: Path) -> None:
    """Without a caller-supplied type the registry declines the same file:
    ``.json`` is claimed by several bespoke-walked types and needs their roots."""
    path = _settings(tmp_path)
    assert SchemaRegistry.type_for(path) is None
    with pytest.raises(NotAnAsset):
        await resolve_asset(path, write=True)


def test_a_ref_keyed_type_is_declared_as_one() -> None:
    """The refusal is declarative, not a hard-coded list of names."""
    keyed = {n for n in SchemaRegistry.get_all_types() if SchemaRegistry.get(n).keyed_by_ref}
    assert keyed == {"mcp_server", "claude_hook", "plugin"}


def test_a_ref_keyed_id_really_does_differ_without_the_ref(tmp_path: Path) -> None:
    """WHY resolve refuses them: the same file keyed with and without the walk's
    ``json_path`` fragment are two different ids — one asset, two rows."""
    info = SchemaRegistry.get("mcp_server")
    path = _settings(tmp_path)
    from_walk = resolve_id(info, FSRef(path, json_path="/mcpServers/crm"), write=False)
    from_path = resolve_id(info, FSRef(path), write=False)
    assert from_walk != from_path


@pytest.mark.asyncio
async def test_walk_and_resolve_agree_for_a_path_keyed_type(tmp_path: Path) -> None:
    """The other side of the contract: for a type resolve DOES admit, the id it
    settles is the one the walk's ``reconcile`` assigns the same source."""
    doc = tmp_path / "notes.md"
    doc.write_text("# notes\n", encoding="utf-8")
    info = SchemaRegistry.get("markdown")

    resolved = await resolve_asset(doc, write=True)

    assert resolved.type_name == "markdown"
    assert resolve_id(info, FSRef(doc), write=False) == resolved.id


@pytest.mark.asyncio
@pytest.mark.parametrize("type_name", ["claude_session", "codex_session", "copilot_session"])
async def test_a_whole_file_type_may_be_named_by_the_caller(tmp_path: Path, type_name: str) -> None:
    """The transcripts share ``.jsonl``, so the registry cannot classify one on
    its own — and the targeted index (``?type=claude_session&path=…``) is the
    endpoint that re-stamps a session after its transcript changes. Refusing a
    caller-named type here made that index a silent no-op."""
    transcript = tmp_path / "projects" / "-Users-me-work" / "11111111-2222-4333-8444-555555555555.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text('{"type":"user","sessionId":"11111111-2222-4333-8444-555555555555"}\n', encoding="utf-8")

    assert SchemaRegistry.type_for(transcript) is None, "precondition: ambiguous by extension alone"

    resolved = await resolve_asset(transcript, write=False, type_name=type_name, known_unowned=True)

    assert resolved.type_name == type_name
    assert resolved.root == transcript


@pytest.mark.asyncio
async def test_a_named_type_that_does_not_claim_the_path_is_still_refused(tmp_path: Path) -> None:
    """Naming a type is not a licence to mint: the shape still has to match."""
    script = tmp_path / "server.py"
    script.write_text("x = 1\n", encoding="utf-8")

    with pytest.raises(NotAnAsset):
        await resolve_asset(script, write=False, type_name="claude_session", known_unowned=True)

    assert script.read_text(encoding="utf-8") == "x = 1\n"
