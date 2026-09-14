"""Application scope and selected-harness resolution."""
from __future__ import annotations

import os
from pathlib import Path

from flow_sdk.assets.placement import LAYOUT_REGISTRY, HarnessType, Scope, coerce_harness, family_subdir


async def resolve_default_harness() -> "HarnessType":
    """The machine's canonical harness — which single copy flowpad writes (step C).

    Precedence: (1) the installed + user-selected ``HARNESS`` capability, via the
    existing capability layer; (2) the ``FLOWPAD_DEFAULT_WORKER`` env var; (3)
    ``claude`` (reproduces today's ``.claude/*`` layout exactly). Never raises —
    an unavailable/erroring capability layer falls straight through to the env.
    """
    try:
        from flow_sdk.core.capabilities.registry import resolve_default_harness_kind  # noqa: PLC0415

        harness = coerce_harness(await resolve_default_harness_kind())
        if harness is not None:
            return harness
    except Exception:  # noqa: BLE001 — capability layer is best-effort here
        pass
    return coerce_harness(os.environ.get("FLOWPAD_DEFAULT_WORKER")) or HarnessType.CLAUDE


def root_for_scope(scope: str, *, project_mount: str | Path | None = None) -> Path | None:
    """The single scope-root resolver — collapses ``_user_scope_root`` (receive)
    and ``_resolve_scope_root`` (create) into one.

    USER → the per-instance ``user_home``. PROJECT → the project's mount path.
    Returns None when a project scope has no mount (nothing to write under).
    """
    if scope == Scope.PROJECT:
        return Path(project_mount) if project_mount else None
    if scope == Scope.USER:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        return get_instance_settings().user_home
    return None  # SYSTEM is never a write destination


def resolve_destination(
    type_name: str,
    scope: str,
    *,
    default_worker: str,
    project_mount: str | Path | None = None,
) -> Path | None:
    """THE placement resolver. Returns the scope-root-anchored **family
    directory** for a type, or None when the type has no layout or the scope is
    unsupported.

    The file-vs-folder / ``main_file`` / ``main_ext`` tail stays in
    ``compute_asset_ref`` — this function only owns root + harness + family.

    For a ``singleton`` type the answer is already the asset root (no
    ``<name>`` segment is appended by ``compute_asset_ref``).
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(type_name)
    if info is None:
        return None
    asset_class, harness, family = info._resolved_layout
    subdir = family_subdir(asset_class, harness, family, default_worker=default_worker)
    if subdir is None or not LAYOUT_REGISTRY[asset_class].supports(scope):
        return None
    root = root_for_scope(scope, project_mount=project_mount)
    return root / subdir if root is not None else None
