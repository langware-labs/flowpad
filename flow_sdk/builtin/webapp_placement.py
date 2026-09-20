"""The two companions a registered web app gets, one per plane.

An app is one thing in three planes: the **Artifact** records the source a run
produced, the **Deployment** records where it runs, and the **MicroApp**
records how it is delivered. Both companions hang off the SAME artifact id and
are updated rather than forked when the app is re-registered.

This module owns only the payload shapes. Convergence itself belongs to the
entities — ``Deployment.upsert`` and ``MicroApp.get_by_artifact_id`` — and the
placement of an app was never a fact about the agentic process that happened
to build it, which is why none of this is a method on one.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

#: Where a web build lands, in the order we trust it. Checked only when the
#: registration does not name a ``dist`` itself.
BUILD_OUTPUT_DIRS = ("dist", "build", "out", ".output/public")


async def upsert_deployment(
    artifact,
    *,
    port: int,
    name: str,
    start_cmd: str,
    health: str,
    git_origin,
    project,
) -> Optional[Any]:
    """Create/update the app's runtime placement — a local dev server.

    The row converges through ``Deployment.find_existing`` on (parent,
    provider) — re-registering the same app updates it rather than forking a
    second one, without baking the artifact id into an id that could then
    never change.

    Parented to the PROJECT, not the Artifact: an Artifact records how the app
    was generated and lives under its own parent, while the placement belongs
    to the project that owns the running thing. ``artifact_id`` keeps the
    reference.
    """
    from flow_sdk.builtin.deployment import KIND_WEB, Deployment  # noqa: PLC0415
    from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

    if project is None:
        # Nothing to parent to, and a placement with no owner is not a
        # placement — the caller's project resolution already tried three ways
        # to find one.
        return None
    deployment = await Deployment.upsert(
        parent_type_id=str(project.typeid),
        provider="local",
        kind=KIND_WEB,
        element=project,
        payload={
            "name": f"{name} (local)",
            "artifact_id": artifact.id,
            "artifact_link_source": "manual",
            "target": {
                "provider": "local",
                "scope": project.id,
                "location": f"http://localhost:{port}",
            },
            "origin": {
                "kind": "local",
                "provider": "local",
                "external_id": ComputeNode._local_id(),
                "url": f"http://localhost:{port}",
            },
            "status": {"sync_state": "current", "provider_state": "configured"},
            "provider_labels": {
                "flowpad.runtime.port": str(port),
                "flowpad.runtime.start_cmd": start_cmd,
                "flowpad.runtime.health": health,
            },
            "source_revision": getattr(git_origin, "head_commit", None),
            "project_id": project.id,
        },
    )
    await project.attach_child(deployment)
    return deployment


async def upsert_micro_app(
    artifact,
    *,
    artifact_path: str,
    name: str,
    dist: object,
    project,
    fallback_project_id: str | None = None,
) -> Optional[Any]:
    """Create/update the Artifact's delivery companion when built output exists.

    Returns ``None`` when the app has no build output yet — a dev-server-only
    app is a complete, valid app, so absence is the normal early state and not
    an error.
    """
    from flow_sdk.builtin.faas.micro_app import MicroApp  # noqa: PLC0415
    from flow_sdk.schema.data_spec.app_location_type import AppLocationType  # noqa: PLC0415

    app_root = Path(artifact_path)
    dist_rel = str(dist or "").strip()
    if dist_rel:
        dist_path = app_root / dist_rel
    else:
        dist_path = next((app_root / c for c in BUILD_OUTPUT_DIRS if (app_root / c).is_dir()), None)
        # A static app has no build step — the registered folder IS the
        # deliverable, and discovery points at whichever directory holds
        # index.html. Without this, exactly the apps that are ready to serve
        # with no work at all would be the ones that never get a delivery
        # companion.
        if dist_path is None and (app_root / "index.html").is_file():
            dist_path = app_root
    if dist_path is None:
        return None

    # LOOKUP, not an id derived from the artifact's: the row's natural key is
    # the artifact it delivers. Same idempotency on re-registration, and it
    # also finds rows minted before the convention existed.
    micro_app = await MicroApp.get_by_artifact_id(artifact.id)
    payload = {
        "name": name,
        "location_type": AppLocationType.Artifact,
        "location_root": str(dist_path),
        "artifact_id": artifact.id,
        "project_id": project.id if project is not None else fallback_project_id,
        "parent_type_id": str(project.typeid) if project is not None else None,
    }
    if micro_app is None:
        micro_app = MicroApp(**payload)
    else:
        micro_app.apply_field_updates(payload)
    await micro_app.save()
    if project is not None:
        await project.attach_child(micro_app)
    return micro_app


__all__ = ["BUILD_OUTPUT_DIRS", "upsert_deployment", "upsert_micro_app"]
