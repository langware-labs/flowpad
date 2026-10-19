"""An Artifact must never shadow the asset it points at.

``Entity.get_by_asset_ref`` enrols EVERY type declaring an ``asset_ref`` field
and returns the first non-``None`` hit across them, in registry order. Its
contract says ``asset_ref`` is "globally unique (one entity per file path across
all types)".

An artifact references an asset, so both rows naturally carry the same path —
which puts two entities on one ``asset_ref`` and makes the winner an accident of
registry ordering. If the artifact wins, every path→entity consumer resolves to
the wrong thing: display-target resolution, cross-linking, the docs chip, and
the indexer's identity gate.

This module is the structural guard: the artifact type must not be enrolled as a
candidate path owner at all. The behavioural half — that a shared path actually
resolves to the wrong entity — needs a real file-backed asset, whose save
requires the embedded blob storage the unit tier does not provide, so it lives in
``tests/api/test_artifact_asset_ref_shadowing.py``.
"""

from __future__ import annotations

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


def _path_owner_candidates() -> list[str]:
    """Mirror of the candidate predicate inside ``Entity.get_by_asset_ref``."""
    return [
        cls.get_type()
        for cls in SchemaRegistry.get_all_entity_classes()
        if "asset_ref" in getattr(cls, "model_fields", {}) and getattr(cls, "owns_asset_ref", True)
    ]


async def test_artifacts_are_not_enrolled_as_path_owners():
    """The structural half: an artifact carries an ``asset_ref`` but must not be a
    candidate OWNER of that path, or it competes with the entity it references."""
    candidates = _path_owner_candidates()

    assert "artifact" not in candidates, (
        f"artifact is enrolled in the get_by_asset_ref candidate set {candidates} — "
        "it will compete with real file-backed types for path ownership"
    )


async def test_artifact_still_declares_asset_ref():
    """The exclusion must come from ``owns_asset_ref``, not from dropping the
    field — the artifact still has to record which path it points at."""
    from flow_sdk.builtin.artifact import Artifact

    assert "asset_ref" in Artifact.model_fields
    assert Artifact.owns_asset_ref is False


async def test_real_asset_types_remain_path_owners():
    """The exclusion must be surgical — file-backed types keep answering."""
    candidates = _path_owner_candidates()

    assert "spec" in candidates
    assert "dataset" in candidates
