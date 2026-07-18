"""Single seam for on-disk asset placement.

Historically *where an asset lands* was decided in two unrelated engines (create
vs receive) around a per-type ``main_subdir`` string that fused three orthogonal
decisions into one hardcoded literal: the harness prefix (``.claude/``), the
family (``skills``), and — implicitly — the layout. Because the prefix was a
welded-on constant, there was no harness axis at all.

This module factors those apart. ``family_subdir`` is the single seam that turns
``(asset_class, harness, family)`` (declared on the type) plus ``default_worker``
into a scope-relative subdir; ``root_for_scope`` is the single scope→root seam.
Every placement path composes those two: ``resolve_destination`` (root+subdir),
``FSRecord.compute_asset_ref`` (a caller-supplied root + subdir + file/folder
tail), and ``TypeInfo.main_subdir`` (the claude-canonical subdir view). The
receive path replays the sender-staged relpath and so is not yet harness-aware
(a fan-out concern) — it shares ``root_for_scope`` and the ``user_scope_allowed``
policy, not ``family_subdir``.

The module is deliberately dependency-light: only stdlib + ``_compat``, with
``SchemaRegistry`` and ``instance_settings`` lazy-imported inside the functions
that need them (avoids an import cycle at load time).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from flow_sdk._compat import StrEnum


class HarnessType(StrEnum):
    """The layout vocabulary — one member per AI-coding harness whose on-disk
    convention we can write into. Mirrors the sibling ``syncmd`` harness set, so
    the fan-out target folders stay in lockstep with what syncmd propagates.

    Distinct from ``WorkerType`` (the runtime driver, ``flowpad_types.enums``)
    and ``CapabilityKind`` (``harness.<name>.cli``); ``worker_capability_kind``
    bridges the driver name → capability kind.
    """

    CLAUDE = "claude"
    AGENTS = "agents"
    GITHUB = "github"
    COPILOT = "copilot"


class AssetClass(StrEnum):
    """The "definition" axis — what an asset type fundamentally is."""

    INTERNAL = "internal"  # flowpad's own subtree; no harness prefix, no fan-out
    HARNESS = "harness"    # tied to ONE harness (declared via ``TypeInfo.harness``)
    SHARED = "shared"      # every harness understands it → syncmd fan-out
    NONE = "none"          # raw files, no TypeInfo, no harness semantics


class Scope(StrEnum):
    """The collapsed placement/discovery scope vocabulary.

    ``USER`` and ``PROJECT`` are the only valid *placement inputs*. ``SYSTEM`` is
    a derived, read-only tag (stamped by ``classify_path`` / the system roots);
    it never selects a write destination.
    """

    USER = "user"
    PROJECT = "project"
    SYSTEM = "system"


# The ONLY place a harness maps to its dot-directory. GitHub Copilot's skills
# live under ``.github`` just like the ``github`` harness, so both point there.
WORKER_PREFIX: dict[str, str] = {
    HarnessType.CLAUDE: ".claude",
    HarnessType.AGENTS: ".agents",
    HarnessType.GITHUB: ".github",
    HarnessType.COPILOT: ".github",
}

# Driver/worker name (``FLOWPAD_DEFAULT_WORKER`` value, ``WorkerType`` variants)
# → placement harness. Accepts the driver aliases so the env var can be set to
# any name the agentic-process layer already understands.
_WORKER_NAME_TO_TYPE: dict[str, "HarnessType"] = {
    "claude": HarnessType.CLAUDE,
    "claude_code": HarnessType.CLAUDE,
    "claude_code_cli": HarnessType.CLAUDE,
    "codex": HarnessType.AGENTS,
    "agents": HarnessType.AGENTS,
    "copilot": HarnessType.COPILOT,
    "github": HarnessType.GITHUB,
}


def coerce_harness(value: object) -> "HarnessType | None":
    """Best-effort map a capability kind / worker name / harness value onto a
    ``HarnessType``. Returns None when nothing recognizes it."""
    if not value:
        return None
    v = str(value).strip().lower()
    if v in _WORKER_NAME_TO_TYPE:
        return _WORKER_NAME_TO_TYPE[v]
    if v in WORKER_PREFIX:  # already a harness value
        return HarnessType(v)
    # Capability leaf kinds (``harness.<tool>.cli``). Keyed off ``CapabilityKind``
    # so a kind rename can't silently drift; codex speaks the ``.agents`` standard.
    from flow_sdk.core.capabilities.models import CapabilityKind  # noqa: PLC0415

    return {
        CapabilityKind.CLAUDE_CLI.value: HarnessType.CLAUDE,
        CapabilityKind.CODEX_CLI.value: HarnessType.AGENTS,
        CapabilityKind.COPILOT_CLI.value: HarnessType.COPILOT,
    }.get(v)


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


@dataclass(frozen=True)
class LayoutClass:
    """The placement policy for one ``AssetClass`` — declared data, not code.

    ``harness_scoped`` decides whether the mount is prefixed by a harness
    dot-dir (everything except INTERNAL). ``fan_out`` marks the classes syncmd
    mirrors across harnesses (SHARED). ``user_scope`` / ``project_scope`` are the
    installability predicate that replaces the old ``.claude``-prefix hack.
    """

    harness_scoped: bool
    fan_out: bool
    user_scope: bool
    project_scope: bool = True

    def mount(self, family: str, *, harness: str | None) -> str:
        """Scope-root-relative subdir for the ONE canonical copy flowpad writes."""
        if not self.harness_scoped:
            return family
        prefix = WORKER_PREFIX.get(harness or HarnessType.CLAUDE, ".claude")
        return f"{prefix}/{family}"

    def supports(self, scope: str) -> bool:
        if scope == Scope.USER:
            return self.user_scope
        if scope == Scope.PROJECT:
            return self.project_scope
        return False  # SYSTEM (or anything else) is never a placement input


LAYOUT_REGISTRY: dict[AssetClass, LayoutClass] = {
    AssetClass.INTERNAL: LayoutClass(harness_scoped=False, fan_out=False, user_scope=False),
    AssetClass.HARNESS: LayoutClass(harness_scoped=True, fan_out=False, user_scope=True),
    AssetClass.SHARED: LayoutClass(harness_scoped=True, fan_out=True, user_scope=True),
    AssetClass.NONE: LayoutClass(harness_scoped=True, fan_out=False, user_scope=True),
}


def user_scope_allowed(asset_class: "AssetClass | None", *, is_git: bool = False) -> bool:
    """Whether "Install global" (user scope) is offered for a received asset —
    the single owner of that policy, replacing the old ``.claude``-prefix hack.

    Git transfers resolve their own checkout location, so they are always
    user-installable; otherwise the asset class's declared ``user_scope`` decides
    (INTERNAL is project-only). Stamped once at stage time and re-enforced at
    install through this same predicate.
    """
    if is_git:
        return True
    return asset_class is not None and LAYOUT_REGISTRY[asset_class].supports(Scope.USER)


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


def effective_harness(
    asset_class: AssetClass, declared: HarnessType | None, default_worker: str
) -> str | None:
    """Which harness's convention this write uses: the type's declared harness
    for HARNESS types, the caller's ``default_worker`` for SHARED/NONE, and none
    for INTERNAL (which is harness-less)."""
    if asset_class == AssetClass.HARNESS:
        return declared or HarnessType.CLAUDE
    if asset_class == AssetClass.INTERNAL:
        return None
    return default_worker  # SHARED, NONE → the machine's canonical harness


def family_subdir(
    asset_class: "AssetClass | None",
    harness: "HarnessType | None",
    family: str | None,
    *,
    default_worker: str,
) -> str | None:
    """THE single seam: the scope-relative subdir for a type's canonical copy
    (``.claude/skills``, ``docs``, ``.agents/skills``). ``None`` when the type has
    no layout. Composed by ``resolve_destination``, ``compute_asset_ref``, and the
    ``main_subdir`` property so the mount rule lives in exactly one place."""
    if asset_class is None or family is None:
        return None
    eff = effective_harness(asset_class, harness, default_worker)
    return LAYOUT_REGISTRY[asset_class].mount(family, harness=eff)


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


def resolve_raw_file_destination(
    filename: str,
    scope: str,
    *,
    default_worker: str,
    project_mount: str | Path | None = None,
) -> Path | None:
    """Destination directory for a raw OS-picker file (NONE class) — a file with
    no TypeInfo. Markdown → ``<harness>/docs``, everything else → ``<harness>/files``.
    Single owner of the raw-file layout so stage-time and install-time agree.
    """
    if not LAYOUT_REGISTRY[AssetClass.NONE].supports(scope):
        return None
    root = root_for_scope(scope, project_mount=project_mount)
    if root is None:
        return None
    return root / raw_file_rel_subdir(filename, default_worker=default_worker)


def raw_file_rel_subdir(filename: str, *, default_worker: str = HarnessType.CLAUDE) -> str:
    """Scope-relative subdir for a raw file (NONE class) — e.g. ``.claude/docs``
    for markdown, ``.claude/files`` otherwise. Single owner of the raw-file
    layout, shared by stage-time entry layout and install-time resolution so the
    two can never disagree.
    """
    from flow_sdk.builtin.flow_message_bundle import is_markdown_filename  # noqa: PLC0415

    family = "docs" if is_markdown_filename(filename) else "files"
    return LAYOUT_REGISTRY[AssetClass.NONE].mount(family, harness=default_worker)
