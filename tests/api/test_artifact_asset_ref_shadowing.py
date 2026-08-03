"""An Artifact must never shadow the asset it points at.

``Entity.get_by_asset_ref`` enrols EVERY type declaring an ``asset_ref`` field
and returns the first non-``None`` hit across them, in registry order. Its
contract says ``asset_ref`` is "globally unique (one entity per file path across
all types)".

An artifact references an asset, so both rows naturally carry the same path.
That puts two entities on one ``asset_ref`` and makes the winner an accident of
``SchemaRegistry`` ordering. If the artifact wins, every path→entity consumer
resolves to the wrong thing: display-target resolution, cross-linking, the docs
chip, and the indexer's identity gate.

Lives in the api tier because saving a real file-backed asset needs the embedded
blob storage the unit tier does not provide (``_embedded_storage_fallback``).
The structural half of this guard — that ``artifact`` is not enrolled as a path
owner at all — is a pure registry check and stays in
``tests/unit/test_artifact_asset_ref_shadowing.py``.
"""

from __future__ import annotations

from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.spec import Spec
from flow_sdk.core import Entity

_PATH = "/tmp/artifact-shadow-probe/report.md"


async def test_a_path_resolves_to_the_asset_not_the_artifact(bootstrapped_client):
    """The invariant: an artifact pointing at a spec must not become the answer
    to "which entity owns this path"."""
    spec = Spec(name="the-real-asset", asset_ref=_PATH)
    await spec.save(notify=False)

    artifact = Artifact(name="the-artifact", kind="content.file.text", asset_ref=_PATH)
    await artifact.save(notify=False)

    # Sanity — both really persisted with this path, so a pass below cannot be a
    # false negative from a row that never saved.
    assert await Spec.get_one({"asset_ref": _PATH}) is not None, "spec did not persist"
    assert await Artifact.get_one({"asset_ref": _PATH}) is not None, "artifact did not persist"

    resolved = await Entity.get_by_asset_ref(_PATH)

    assert resolved is not None
    assert resolved.get_type() == "spec", (
        f"a path resolved to {resolved.get_type()!r} instead of the asset that owns it — "
        "an Artifact sharing an asset_ref shadows the real entity, and which one wins is "
        "decided by SchemaRegistry ordering inside Entity.get_by_asset_ref"
    )


async def test_an_artifact_is_not_a_wiki_resolution_candidate(bootstrapped_client):
    """The same ownership rule, second consumer.

    ``wiki.service._implicit_project_assets`` enrols any type carrying both
    ``project_id`` and ``asset_ref``. An artifact carries both, and shares its
    referenced asset's name — so without the ``owns_asset_ref`` guard every
    registered artifact becomes a second candidate for its own document's name,
    turning a unique ``[[link]]`` ambiguous.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    candidates = [
        cls.get_type()
        for cls in SchemaRegistry.get_all_entity_classes()
        if "project_id" in getattr(cls, "model_fields", {})
        and "asset_ref" in getattr(cls, "model_fields", {})
        and getattr(cls, "owns_asset_ref", True)
        and cls.get_type() not in {"project", "wiki", "wiki_entry"}
    ]

    assert "artifact" not in candidates, (
        f"artifact is an implicit wiki-resolution candidate {candidates} — it will "
        "compete with the asset it references for that asset's own name"
    )


async def test_a_path_resolves_to_an_asset_type_registered_after_artifact(bootstrapped_client):
    """The same invariant for a type that sorts AFTER ``artifact``.

    ``spec`` happens to precede ``artifact`` in the candidate list, so it wins by
    luck of ordering. ``dataset`` follows it. Whether a path resolves correctly
    must not depend on where a type lands in ``SchemaRegistry`` iteration order.
    """
    from flow_sdk.builtin.dataset import Dataset

    path = "/tmp/artifact-shadow-probe/trainset"

    dataset = Dataset(name="the-real-dataset", asset_ref=path)
    await dataset.save(notify=False)

    artifact = Artifact(name="the-artifact", kind="content.data", asset_ref=path)
    await artifact.save(notify=False)

    assert await Dataset.get_one({"asset_ref": path}) is not None, "dataset did not persist"
    assert await Artifact.get_one({"asset_ref": path}) is not None, "artifact did not persist"

    resolved = await Entity.get_by_asset_ref(path)

    assert resolved is not None
    assert resolved.get_type() == "dataset", (
        f"a path resolved to {resolved.get_type()!r} instead of the dataset that owns it — "
        "the Artifact won only because it precedes 'dataset' in SchemaRegistry order"
    )
