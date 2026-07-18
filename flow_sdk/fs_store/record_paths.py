"""On-disk path conventions for FS records.

Survives the Phase-5 deletion of ``flow_sdk/fs_store/record.py`` — provides
the path helpers that the indexer, FSRecord, and operations modules need.
"""
from __future__ import annotations

from pathlib import Path


def _instance_settings():
    from flow_sdk.instance_settings import get_instance_settings
    return get_instance_settings()


def get_flowpad_home() -> Path:
    """Per-instance flow home (call-time, via InstanceSettings)."""
    return _instance_settings().flow_home


def get_default_records_root() -> Path:
    """Per-instance records root (call-time, via InstanceSettings)."""
    return _instance_settings().records_root


def get_default_records_data_root() -> Path:
    """Per-instance records data root (call-time, via InstanceSettings)."""
    return _instance_settings().records_data_dir


def set_default_records_root(path: Path) -> None:
    """Test-only: redirect records_root via the InstanceSettings override."""
    from flow_sdk.instance_settings import override_records_root
    override_records_root(path)


def set_default_records_data_root(path: Path) -> None:
    """Test-only: redirect records_data_dir.

    No env-var hook exists for this field — fall back to monkey-overriding
    the ``get_default_records_data_root`` getter on this module. Test
    fixtures should call this inside a ``monkeypatch.setattr`` block.
    """
    global get_default_records_data_root
    get_default_records_data_root = lambda: path  # noqa: E731


# Canonical naming: ``<type>-<id>`` — the ordinary TypeId form (delimiter ``-``,
# split on the FIRST ``-`` so the id may itself contain hyphens, e.g. a UUID).
# This is the SELF-DESCRIBING token used in flat / portable namespaces (bundle
# attachment arcs, staging keys, VFS segments). The type-scoped shadow store does
# NOT use this — it stores a bare id under a ``<type>/`` parent (``records/<type>/<id>/``).
#
# ``@`` is the *uname* sigil (``named_id_pattern = ^@[a-zA-Z]…``) and belongs ONLY
# on genuine named identifiers (``@local``, ``agent-@myagent``); it is never emitted
# next to a UUID. The old convention fused the two (``<type>-@<uid>``), branding every
# UUID record as a malformed uname — ``parse_record_stem`` reads that legacy shape for
# back-compat (old on-disk folders / received bundles) but the builder never writes it.
_NAME_SEP = "-"
_METADATA_JSON = "metadata.json"


def record_stem(record_type: str, uid: str) -> str:
    """Build the canonical ``<type>-<id>`` stem for a portable / flat-namespace token."""
    return f"{record_type}{_NAME_SEP}{uid}"


def parse_record_stem(stem: str) -> tuple[str, str]:
    """Parse a ``<type>-<id>`` stem into ``(type, id)``, splitting on the first ``-``.

    Tolerates the legacy ``<type>-@<id>`` shape (the retired uname-sigil separator)
    by stripping a leading ``@`` off the id, so pre-existing on-disk folders and
    already-received ``.flowmsg`` bundles still parse.
    """
    record_type, sep, uid = stem.partition(_NAME_SEP)
    if not sep:
        raise ValueError(f"Invalid record stem: {stem!r}")
    if uid.startswith("@"):  # legacy <type>-@<id>
        uid = uid[1:]
    return record_type, uid


# Type-scoped store layout. A record lives at ``<records_root>/<type>/<id>/`` (a
# BARE id under a ``<type>/`` parent). These are the single seam for that shape —
# call them instead of hand-inlining ``root / type / str(id)``.
def shadow_dir_for(record_type: object, uid: object) -> Path:
    """The record's metadata (shadow) folder: ``<records_root>/<type>/<id>/``."""
    return get_default_records_root() / str(record_type) / str(uid)


def data_dir_for(record_type: object, uid: object) -> Path:
    """The record's data-blob folder: ``<records_data_root>/<type>/<id>/``."""
    return get_default_records_data_root() / str(record_type) / str(uid)


def is_record_dir(path: Path) -> bool:
    """True iff ``path`` is a materialized record folder (holds ``metadata.json``).

    The naming-agnostic "is this a record?" test — replaces sniffing the folder
    name for the retired ``-@`` separator.
    """
    return path.is_dir() and (path / _METADATA_JSON).is_file()
