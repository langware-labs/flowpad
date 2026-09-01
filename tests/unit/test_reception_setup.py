"""Reception → vibe-setup seam (slick artifact reception pipeline).

Covers the two backend seams without a browser:
  * ``TypeInfo.setup_skill`` / ``reception_verb`` are declared per type.
  * ``Entity.setup_on_receive`` dispatches on the type: no skill ⇒ open the entity;
    a skill ⇒ spawn a headless Vibe ``AgenticProcess`` and return ITS target.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import flow_sdk.models.entities  # noqa: F401 — attaches entity_cls onto every TypeInfo
from flow_sdk.schema.type_info import register_all
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.types import EntityType
from flow_sdk.api.api_types.identifier import mint_uuid

register_all()


def test_reception_typeinfo_declared_per_type():
    artifact = SchemaRegistry.get(EntityType.ARTIFACT.value)
    assert artifact.setup_skill == "artifact-setup"
    assert artifact.reception_verb == "Set up"
    # The FE reads these off the bootstrap surface.
    d = artifact.to_dict()
    assert d["setup_skill"] == "artifact-setup" and d["reception_verb"] == "Set up"

    skill = SchemaRegistry.get(EntityType.SKILL.value)
    # SELF sentinel: run the received entity as its own skill.
    assert skill.setup_skill == EntityType.SKILL.value
    assert skill.reception_verb == "Run"

    markdown = SchemaRegistry.get(EntityType.MARKDOWN.value)
    assert markdown.setup_skill is None  # a note has no setup agent
    assert markdown.reception_verb == "Open"


@pytest.mark.asyncio
async def test_setup_on_receive_no_skill_opens_entity():
    cls = SchemaRegistry.get_entity_cls(EntityType.MARKDOWN.value)
    note = cls(id=mint_uuid(), title="note")
    dt = await note.setup_on_receive(project_id=None, workdir=None)
    assert dt["kind"] == "entity"
    assert dt["type"] == EntityType.MARKDOWN.value
    assert dt["id"] == note.id  # opens the received note itself — no process spawned


@pytest.mark.asyncio
async def test_setup_on_receive_artifact_spawns_vibe(monkeypatch, tmp_path):
    from flow_sdk.builtin.artifact import Artifact
    from flow_sdk.fs_store.origin.local_origin import LocalOrigin
    import flow_sdk.core.entity.entity_model as em

    # Don't actually launch a Claude worker in a unit test — assert the process is
    # spawned + the target is returned; the seed scheduling is covered separately.
    seeded: dict = {}

    def _fake_schedule(ap, seed):
        seeded["ap_id"] = ap.id
        seeded["seed"] = seed

    monkeypatch.setattr(em, "_schedule_setup_prompt", _fake_schedule)

    art = Artifact(
        id=mint_uuid(),
        name="spora",
        kind="application.web",
        origin=LocalOrigin(base=str(tmp_path), rel_path="."),
    )
    project_id = mint_uuid()
    dt = await art.setup_on_receive(project_id=project_id, workdir=str(tmp_path))

    # The target is the spawned Vibe process, not the artifact itself.
    assert dt["kind"] == "entity"
    assert dt["type"] == EntityType.AGENTIC_PROCESS.value
    ap_id = dt["id"]

    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    ap = await AgenticProcess.get_one({"id": ap_id})
    assert ap is not None
    assert ap.load_flowpad_assistant is True
    assert ap.pty_mode is False
    assert (ap.context_data or {}).get("launched_from") == "artifact_setup"
    assert (ap.context_data or {}).get("source_artifact_id") == art.id

    # The seed names the built-in setup skill + the artifact to set up.
    assert seeded.get("ap_id") == ap_id
    assert "artifact-setup" in seeded["seed"]
    assert f"artifact-{art.id}" in seeded["seed"]


@pytest.mark.asyncio
async def test_non_webapp_artifact_opens_entity_without_setup_spawn(monkeypatch, tmp_path):
    from flow_sdk.builtin.artifact import Artifact
    from flow_sdk.fs_store.origin.local_origin import LocalOrigin
    import flow_sdk.core.entity.entity_model as em

    # A non-webapp artifact must NOT spawn a setup session — it's a produced file.
    monkeypatch.setattr(em, "_schedule_setup_prompt", lambda ap, seed: pytest.fail("must not spawn"))

    art = Artifact(
        id=mint_uuid(),
        name="analysis",
        kind="content.file.data",
        origin=LocalOrigin(base=str(tmp_path), rel_path="out.json"),
    )
    dt = await art.setup_on_receive(project_id=None, workdir=None)
    assert dt["kind"] == "entity"
    assert dt["type"] == EntityType.ARTIFACT.value
    assert dt["id"] == art.id


@pytest.mark.asyncio
async def test_artifact_origin_is_data_not_setup_workdir(tmp_path):
    from flow_sdk.builtin.artifact import Artifact
    from flow_sdk.fs_store.origin.local_origin import LocalOrigin

    served = tmp_path / "webapps" / "spora"
    served.mkdir(parents=True)
    art = Artifact(
        id=mint_uuid(),
        name="spora",
        kind="application.web",
        origin=LocalOrigin(base=str(served.parent), rel_path=served.name),
    )
    assert Path(art.origin.base) / art.origin.rel_path == served
    assert not hasattr(art, "path")
