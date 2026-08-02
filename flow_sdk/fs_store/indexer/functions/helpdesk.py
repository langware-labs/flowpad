"""Extractor + id mint + asset-hash for HELPDESK records.

A help desk is a folder containing ``helpdesk.json`` — the manifest naming the
hub project that owns the ticket queue — alongside the guides themselves
(ordinary markdown, indexed separately). Discovery is the generic
``repo_assets_fn`` walk of ``<scope>/agentic-assets/helpdesk/*/``; this module
owns only the extractor, id mint and asset-hash.

Identity is DERIVED, not stored. The two alternatives both damage the checkout:
a native-JSON backend would write an ``id`` into the tracked ``helpdesk.json``,
so the next ``git pull`` fails with "local changes would be overwritten"; the
folder-capsule backend writes ``.flow/id`` into every clone and mints a
different v4 per machine. A key derived from the repo coordinates is read-only,
byte-stable across machines, and idempotent across re-clones — which matters
because the same portal repo is cloned by every project that consults the desk.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.utils.git import find_project_root, git_remote_url
from flow_sdk.utils.git_identity import canonical_git_origin_repo_key, parse_git_origin_url

HELPDESK_JSON = "helpdesk.json"


def manifest_str(manifest: dict[str, Any], key: str) -> str | None:
    """One normalization for manifest text: coerce, strip, empty → ``None``.

    Shared with the ``Helpdesk`` entity so the two readers cannot drift on what
    counts as "absent".
    """
    value = str(manifest.get(key) or "").strip()
    return value or None


def read_manifest(helpdesk_dir: Path) -> dict[str, Any]:
    """The desk's raw manifest, or ``{}`` when absent/unparseable.

    Disk is the single source of truth (same contract as ``read_auto_launch``
    for journeys): callers read through here at use time rather than trusting a
    denormalized copy, so a ``git pull`` that changes the desk takes effect
    without a re-index.
    """
    try:
        raw = json.loads((helpdesk_dir / HELPDESK_JSON).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _repo_key(path: Path) -> str | None:
    """``git:<provider>:<owner>/<name>`` for the repo containing ``path``.

    Deliberately NOT ``GitOrigin.for_asset_path``: that also resolves the branch
    and HEAD commit — three subprocesses where the key needs one — and this runs
    on the indexer's hot path (see ``helpdesk_stable_key``). The ``try`` covers
    only the probe, so a bug in key construction surfaces instead of silently
    demoting the desk to a machine-local id.
    """
    try:
        root = find_project_root(str(path))
        parsed = parse_git_origin_url(git_remote_url(root)) if root else None
    except Exception:  # noqa: BLE001 — a git probe must never fail an index run
        return None
    if not parsed:
        return None
    provider, owner, name = parsed
    return canonical_git_origin_repo_key(provider, owner, name)


def helpdesk_stable_key(ref: FSRef | Path) -> str:
    """Deterministic v5 key for a portal folder.

    Prefers the REPO coordinates plus the desk's folder name, so two machines —
    and two projects sharing one clone — agree on the id. Falls back to the
    canonical path when the folder is not in a git repo with a usable remote.

    Never returns ``None``: ``mint_uuid(None)`` is a random v4, which would mint
    a fresh id on every scan and defeat skip-fresh.

    Called from ``mint_id`` BEFORE the skip-fresh check, i.e. once per candidate
    folder on every pass — which is why the probe above is kept to one
    subprocess.
    """
    path = ref._path if isinstance(ref, FSRef) else Path(ref)
    repo = _repo_key(path)
    if repo:
        return f"helpdesk:{repo}:{path.name}"
    return f"helpdesk:path:{canonical_posix_path(path)}"


def helpdesk_asset_hash(ref: FSRef) -> float:
    """Freshness tracks the manifest only.

    The guides are ordinary markdown with their own records and their own
    hashes; folding them in here would re-extract the desk on every doc edit
    without changing anything this record holds.
    """
    try:
        return (ref._path / HELPDESK_JSON).stat().st_mtime
    except OSError:
        return 0.0


def extract_helpdesk(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a portal folder into one Record row."""
    path = ref._path
    manifest = read_manifest(path) if path.is_dir() else {}

    display_name = manifest_str(manifest, "display_name") or path.name
    welcome = manifest_str(manifest, "welcome_message")

    rec_kwargs: dict = {
        "type": RecordType.HELPDESK,
        "id": resolved_id,
        "name": display_name,
        "status": "active",
        "content": "\n".join(p for p in (display_name, welcome) if p),
    }
    if welcome:
        rec_kwargs["description"] = welcome
    # desk_project_id / avatar_url are deliberately NOT stored on the row: the
    # entity reads them through to the manifest so a `git pull` that changes the
    # desk takes effect without a re-index (see Helpdesk's docstring). Only the
    # searchable text is denormalized here.
    rec = FSRecord(**rec_kwargs)
    object.__setattr__(rec, "_asset_ref", FSRef(path.resolve()))
    return [rec]
