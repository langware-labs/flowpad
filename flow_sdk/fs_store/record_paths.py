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


# Naming convention: ``<type>-@<uid>``
_NAME_SEP = "-@"


def record_stem(record_type: str, uid: str) -> str:
    """Build the canonical stem used for file / folder names."""
    return f"{record_type}{_NAME_SEP}{uid}"


def parse_record_stem(stem: str) -> tuple[str, str]:
    """Parse a ``<type>-@<uid>`` stem into ``(type, uid)``."""
    if _NAME_SEP not in stem:
        raise ValueError(f"Invalid record stem: {stem!r}")
    record_type, uid = stem.split(_NAME_SEP, 1)
    return record_type, uid
