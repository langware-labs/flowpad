"""Auto-index a project when it is selected — preference read + trigger decision.

The four ``preferences.auto_index.*`` keys are declared canonically in the
frontend registry (``ts_sdk/src/preferences/prefRegistry.ts``) and mirrored in
``flow_sdk/server/routes/bootstrap.py``'s ``default_prefs``. This module owns the
BACKEND half: the key constants both of those import, the value enums, and the
single decision point that turns "the user activated a project" into "run a
scoped index, or don't".

Why the decision lives here rather than at the call sites: ``Project.activate``
and ``Project.save`` both need it, and the "has this project ever been
auto-indexed" marker has to be read and written in exactly one place or the
three trigger modes drift apart.

**Nothing here raises into its caller.** Both entry points are spawned detached
from a request handler, so a failure must degrade to "no auto-index" — never to
a failed activation.

Reading preferences: always via ``read_instance_pref(key, <default>)``, never
``prefs[key]``. ``bootstrap.setup_desktop_filesystem`` only writes
``default_prefs`` when ``preferences.json`` is missing or is the previous stub,
so every existing install lacks these keys and the in-code default below IS the
effective default for upgraders. It must stay identical to the registry's.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any

from flow_sdk.preferences import read_instance_prefs

log = logging.getLogger(__name__)

# ── Preference keys + defaults (mirror prefRegistry.ts / default_prefs) ──────
PREF_AUTO_INDEX_ENABLED = "preferences.auto_index.enabled"
PREF_AUTO_INDEX_TYPE = "preferences.auto_index.index_type"
PREF_AUTO_INDEX_TRIGGER = "preferences.auto_index.index_trigger"
PREF_AUTO_INDEX_FUNCTION = "preferences.auto_index.index_function"

DEFAULT_AUTO_INDEX_ENABLED = True
DEFAULT_AUTO_INDEX_TYPE = "fast"
DEFAULT_AUTO_INDEX_TRIGGER = "first_selection"
DEFAULT_AUTO_INDEX_FUNCTION = "subprocess"

# Epoch-ms of the last auto-index, in the project record's shadow metadata.
#
# Deliberately NOT reusing an existing field. ``indexed_at`` is non-null from
# birth (``Project._stamp_index_sentinel`` stamps a sentinel on create so an
# empty project doesn't read as never-indexed), and ``last_active_at`` is
# destroyed by its own writer (``stamp_last_active_at`` assigns the new value
# before returning, so the pre-stamp value is unreachable). "Has this ever been
# auto-indexed" is a third, genuinely distinct question — conflating it with
# either of those is what makes First Selection either never fire or fire
# forever.
AUTO_INDEX_MARKER_KEY = "auto_index_at"


class IndexType(str, Enum):
    """Depth of an auto-index run."""

    FAST = "fast"   # skip-fresh: only records whose .hash sentinel drifted
    FULL = "full"   # force=True: re-parse and re-upsert every record


class IndexTrigger(str, Enum):
    """When an auto-index fires."""

    PROJECT_CREATE = "project_create"
    FIRST_SELECTION = "first_selection"
    EVERY_SELECTION = "every_selection"


class ScanMode(str, Enum):
    """Where the auto-index's discovery phase runs.

    Declared here, beside the other two auto-index enums, so all three value sets
    and their preference keys live in one module (``builtin`` imports this one).
    """

    THREAD = "thread"          # in-process, chunked onto asyncio.to_thread
    SUBPROCESS = "subprocess"  # displaced into a child process (no DB there)


def coerce_enum(enum_cls: type[Enum], raw: Any, default: str) -> Any:
    """Parse a stored preference string into ``enum_cls``, falling back to
    ``default`` on anything unrecognized.

    Nothing validates preference values on the way in — ``coercePrefValue`` in
    the frontend store only calls ``String()``, so a hand-edited
    ``preferences.json`` can hold ``"Every Selection"`` (display-cased) or plain
    garbage. Treating an unknown value as the default is what keeps that from
    reaching the indexer.
    """
    try:
        return enum_cls(str(raw).strip().lower())
    except (ValueError, AttributeError):
        if str(raw).strip():
            log.debug("[auto-index] unrecognized preference value %r; using %r", raw, default)
        return enum_cls(default)


@dataclass(frozen=True, slots=True)
class AutoIndexConfig:
    """The resolved ``preferences.auto_index.*`` block."""

    enabled: bool
    index_type: IndexType
    trigger: IndexTrigger
    scan_mode: ScanMode

    @property
    def force(self) -> bool:
        """Whether the run bypasses skip-fresh (``IndexerOptions.force``)."""
        return self.index_type is IndexType.FULL


_DEFAULTS = {
    PREF_AUTO_INDEX_ENABLED: DEFAULT_AUTO_INDEX_ENABLED,
    PREF_AUTO_INDEX_TYPE: DEFAULT_AUTO_INDEX_TYPE,
    PREF_AUTO_INDEX_TRIGGER: DEFAULT_AUTO_INDEX_TRIGGER,
    PREF_AUTO_INDEX_FUNCTION: DEFAULT_AUTO_INDEX_FUNCTION,
}


def read_auto_index_config() -> AutoIndexConfig:
    """Read the auto-index preference block off disk in ONE read. Never raises."""
    raw = read_instance_prefs(_DEFAULTS)
    return AutoIndexConfig(
        enabled=bool(raw[PREF_AUTO_INDEX_ENABLED]),
        index_type=coerce_enum(
            IndexType, raw[PREF_AUTO_INDEX_TYPE], DEFAULT_AUTO_INDEX_TYPE
        ),
        trigger=coerce_enum(
            IndexTrigger, raw[PREF_AUTO_INDEX_TRIGGER], DEFAULT_AUTO_INDEX_TRIGGER
        ),
        scan_mode=coerce_enum(
            ScanMode, raw[PREF_AUTO_INDEX_FUNCTION], DEFAULT_AUTO_INDEX_FUNCTION
        ),
    )


# ── The "ever auto-indexed" marker ──────────────────────────────────────────
def _project_record(project_id: str):
    """Load the project's FSRecord, or None. Never raises."""
    try:
        from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415

        return FSRecord.load_or_none("project", str(project_id))
    except Exception:
        log.debug("[auto-index] project record load failed for %s", project_id, exc_info=True)
        return None


def auto_index_marker(project_id: str, rec=None) -> int | None:
    """Epoch-ms of this project's last auto-index, or None if never.

    Reads the project record's shadow ``metadata.json`` (hydrated onto the record
    as an attribute by ``FSRecord.from_dict``). Pass ``rec`` to reuse an
    already-loaded record instead of reading it off disk again. Never raises.
    """
    rec = rec if rec is not None else _project_record(project_id)
    if rec is None:
        return None
    val = getattr(rec, AUTO_INDEX_MARKER_KEY, None)
    return int(val) if val is not None else None


def write_auto_index_marker(project_id: str, ts_ms: int, rec=None) -> None:
    """Stamp the marker. Never raises.

    Written to the record's *shadow* dir, so it cannot perturb
    ``index_required`` — that compares the *asset's* mtime+size, not the shadow.
    Same mechanism ``Entity._http_activate`` already uses to mirror
    ``last_active_at``.
    """
    rec = rec if rec is not None else _project_record(project_id)
    if rec is None:
        return
    try:
        rec.save_metadata_field(AUTO_INDEX_MARKER_KEY, int(ts_ms))
    except Exception:
        log.debug("[auto-index] marker write failed for %s", project_id, exc_info=True)


# ── Entry point ─────────────────────────────────────────────────────────────
async def maybe_auto_index(project_id: str, *, created: bool) -> None:
    """Decide whether this project event should index, and run it if so.

    ``created=True`` comes from ``Project.save``'s create branch, ``False`` from
    ``Project.activate``. Both callers spawn this detached, so it never raises
    into them: a failure degrades to "no auto-index", never to a failed
    activation or a failed project create.

    The trigger test reads as one line because ``project_create`` and the two
    selection modes are mutually exclusive: the event either is a create or
    isn't, and only the matching mode fires.

    The marker is stamped for every mode via ``on_started`` — see
    ``ComputeNode._auto_index_project`` for why that timing matters.
    """
    try:
        cfg = read_auto_index_config()
        if not cfg.enabled:
            return
        if (cfg.trigger is IndexTrigger.PROJECT_CREATE) is not created:
            return
        rec = _project_record(project_id)
        if cfg.trigger is IndexTrigger.FIRST_SELECTION and auto_index_marker(project_id, rec) is not None:
            return
        await _run_auto_index(project_id, cfg, rec)
    except Exception:
        log.debug(
            "[auto-index] %s pass skipped for %s",
            "create" if created else "activation",
            project_id,
            exc_info=True,
        )


async def _run_auto_index(project_id: str, cfg: AutoIndexConfig, rec=None) -> None:
    """Run one scoped auto-index, stamping the marker once the run really starts.

    ``rec`` is the already-loaded project record, threaded through so one auto
    index reads it once rather than three times (marker read, marker write, and
    the sentinel stamp inside ``_run_index_activity``).

    The marker is stamped for every trigger mode, so flipping ``Project Create``
    → ``First Selection`` does not re-fire for projects created under the old
    setting.
    """
    from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415
    from flow_sdk.utils.serialization import now_epoch_ms  # noqa: PLC0415

    # create=False: an auto path must never mint a compute node as a side effect.
    node = await ComputeNode.get_local(create=False)
    if node is None:
        return

    await node._auto_index_project(
        project_id,
        force=cfg.force,
        trigger=f"auto:{cfg.trigger.value}",
        scan_mode=cfg.scan_mode,
        project_record=rec,
        on_started=lambda: write_auto_index_marker(project_id, now_epoch_ms(), rec),
    )
