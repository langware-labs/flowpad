"""Addressing a deliverable that is a row, not a file.

``asset_ref`` assumes every artifact is a file on disk. A message an agent sent
is not: the ``SourceItem`` it created has no path at all, so registering it the
old way produced an artifact with an empty ``asset_ref`` — a row pointing at
nothing, indistinguishable from a bug. These tests pin the identity form and the
kind that rides with it.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.artifact_on_tag import emit_artifact_tag
from flow_sdk.core.display_target import DisplayTargetKind

SOURCE_ITEM_TYPEID = "source_item-7c9a1f30-4d21-5b88-9f02-1a2b3c4d5e6f"
DOCUMENT_TYPEID = "document-6f1e2d3c-4b5a-4c8d-9e0f-a1b2c3d4e5f6"
PROCESS_TYPEID = "agentic_process-11111111-2222-4333-8444-555555555555"


class TestTheFieldItself:
    def test_an_artifact_can_reference_an_entity_with_no_path(self):
        artifact = Artifact(name="Re: Round trip", kind="content.message.email",
                            target_type_id=SOURCE_ITEM_TYPEID)
        assert artifact.target_type_id == SOURCE_ITEM_TYPEID
        assert artifact.asset_ref == ""

    def test_it_defaults_to_none_so_existing_rows_are_untouched(self):
        # Every artifact registered before this field existed must still load.
        assert Artifact(name="report.html", kind="content.file").target_type_id is None

    def test_both_forms_can_coexist(self):
        # A file-backed entity has a path AND an identity; the identity is exact
        # where the path has to be resolved back through get_by_asset_ref.
        artifact = Artifact(name="plan.md", kind="content.file",
                            asset_ref="/w/plan.md", target_type_id=DOCUMENT_TYPEID)
        assert (artifact.asset_ref, artifact.target_type_id) == ("/w/plan.md", DOCUMENT_TYPEID)


class TestTheBusLane:
    """An event a subscriber cannot resolve is noise. A file-less artifact
    carries no `asset_ref`, so the identity has to ride the lane too."""

    def _emitted(self, monkeypatch, artifact) -> dict:
        seen: dict = {}

        def _emit(tag, target, data, ctx=None):
            seen.update(tag=tag, target=target, data=data, ctx=ctx or {})

        monkeypatch.setattr("flow_sdk.tags.emit_tag", _emit)
        emit_artifact_tag(artifact, "created")
        return seen

    def test_the_target_rides_the_created_event(self, monkeypatch):
        artifact = SimpleNamespace(id="a-1", generated_by=PROCESS_TYPEID, asset_ref="",
                                   kind="content.message.email", target_type_id=SOURCE_ITEM_TYPEID)
        seen = self._emitted(monkeypatch, artifact)
        assert seen["data"]["target_type_id"] == SOURCE_ITEM_TYPEID
        # Lean by law: pointers and identity, never the row.
        assert set(seen["data"]) == {"artifact_id", "generated_by", "asset_ref",
                                     "target_type_id", "kind", "name"}

    def test_an_absent_target_is_null_not_empty_string(self, monkeypatch):
        artifact = SimpleNamespace(id="a-1", generated_by=PROCESS_TYPEID,
                                   asset_ref="/w/x.html", kind="content.file",
                                   target_type_id=None)
        assert self._emitted(monkeypatch, artifact)["data"]["target_type_id"] is None

    def test_a_row_predating_the_field_still_emits(self, monkeypatch):
        # `emit_artifact_tag` reads through getattr precisely so an old row —
        # or a stub — cannot turn a bus emission into an AttributeError.
        artifact = SimpleNamespace(id="a-1", generated_by=PROCESS_TYPEID,
                                   asset_ref="/w/x", kind="content.file")
        assert self._emitted(monkeypatch, artifact)["data"]["target_type_id"] is None


class TestKindComesFromTheEntity:
    """`content.file` for everything non-web erased what the entity already
    knew. A `source_item` IS `content.message.email`, and its (nonexistent)
    path can never recover that."""

    @pytest.fixture
    def resolve(self, monkeypatch):
        """Call ``_artifact_reference`` against a stub entity.

        Exposes ``.lookups`` so a test can assert how many times the entity was
        actually loaded.
        """
        import flow_sdk.core as core
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

        async def _call(payload, entity):
            async def _get_by_typeid(_tid):
                _call.lookups += 1
                return entity

            monkeypatch.setattr(core.Entity, "get_by_typeid", staticmethod(_get_by_typeid))
            proc = AgenticProcess.__new__(AgenticProcess)
            return await proc._artifact_reference(payload)

        _call.lookups = 0
        return _call

    @pytest.mark.asyncio
    async def test_it_reads_the_entitys_own_ontology_kind(self, resolve):
        entity = SimpleNamespace(asset_ref="", kind="content.message.email")
        payload = {"kind": DisplayTargetKind.ENTITY, "typeid": SOURCE_ITEM_TYPEID}
        assert await resolve(payload, entity) == ("", "content.message.email")

    @pytest.mark.asyncio
    async def test_an_entity_declaring_no_kind_yields_nothing_to_override_with(self, resolve):
        entity = SimpleNamespace(asset_ref="/w/plan.md")
        payload = {"kind": DisplayTargetKind.ENTITY, "typeid": DOCUMENT_TYPEID}
        # Empty kind is the signal for the caller's `content.file` fallback.
        assert await resolve(payload, entity) == ("/w/plan.md", "")

    @pytest.mark.asyncio
    async def test_a_path_target_has_no_entity_kind(self, resolve):
        payload = {"kind": DisplayTargetKind.VFS, "path": "/w/report.html"}
        assert await resolve(payload, None) == ("/w/report.html", "")

    @pytest.mark.asyncio
    async def test_one_lookup_serves_both_answers(self, resolve):
        # The path and the kind come off the SAME entity load — asking twice
        # would double the round-trip on every registration.
        entity = SimpleNamespace(asset_ref="", kind="content.message.email")
        await resolve({"kind": DisplayTargetKind.ENTITY, "typeid": SOURCE_ITEM_TYPEID}, entity)
        assert resolve.lookups == 1
