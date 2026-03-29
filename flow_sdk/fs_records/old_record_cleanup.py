"""Startup cleanup: keep only the most recent N records per type."""

import shutil
from pathlib import Path
from flow_sdk.fs_store.record import get_default_records_root

MAX_SHELL_RECORDS = 200
MAX_AGENTIC_RECORDS = 200


def _cleanup_records(record_type: str, max_keep: int) -> int:
    """Delete oldest records beyond max_keep. Returns count deleted."""
    root = get_default_records_root() / record_type
    if not root.is_dir():
        return 0

    dirs = [d for d in root.iterdir() if d.is_dir()]
    if len(dirs) <= max_keep:
        return 0

    # Sort by folder mtime (oldest first); skip dirs that vanished since iterdir()
    def _safe_mtime(d):
        try:
            return d.stat().st_mtime
        except FileNotFoundError:
            return float("inf")  # treat gone dirs as newest so they're not deleted again

    dirs.sort(key=_safe_mtime)
    to_delete = dirs[: len(dirs) - max_keep]

    deleted = 0
    for d in to_delete:
        try:
            shutil.rmtree(d, ignore_errors=True)
            deleted += 1
        except Exception:
            pass
    return deleted


def _skill_record_is_stale(record_dir: Path) -> bool:
    """Return True if a skill shadow record has no live backing skill folder."""
    meta_path = record_dir / "metadata.json"
    if not meta_path.exists():
        return True

    import json
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8")).get("data", {})
    except Exception:
        return True

    # Check asset_ref stored in metadata
    asset_ref_path = data.get("asset_ref")
    if asset_ref_path:
        p = Path(asset_ref_path)
        if (p / "SKILL.md").exists() or (p / "skill.yaml").exists() or (p / "skill.yml").exists():
            return False

    return True


async def cleanup_stale_skill_records() -> int:
    """Delete skill shadow records whose live skill folder no longer exists.

    A stale record is one whose asset_ref no longer has SKILL.md or skill.yaml.
    Returns the number of records deleted.
    """
    from flow_sdk.fs_records.skill_record import SkillRecord

    skill_root = get_default_records_root() / "skill"
    if not skill_root.is_dir():
        return 0

    deleted = 0
    for record_dir in skill_root.iterdir():
        if not record_dir.is_dir():
            continue
        if not _skill_record_is_stale(record_dir):
            continue
        try:
            rec = SkillRecord.load_record(record_dir)
            await rec.delete()
        except Exception:
            pass
        # Always remove the shadow folder — rec.delete() may be a no-op if
        # the record couldn't bind source_file/path (e.g. hash-only dirs).
        if record_dir.exists():
            shutil.rmtree(record_dir, ignore_errors=True)
        deleted += 1
    return deleted


def run_old_record_cleanup() -> None:
    """Called once at startup in a background daemon thread."""
    shell_deleted = _cleanup_records("shell", MAX_SHELL_RECORDS)
    ap_deleted = _cleanup_records("agentic_process", MAX_AGENTIC_RECORDS)
    if shell_deleted or ap_deleted:
        print(f"  Old record cleanup: removed {shell_deleted} shell + {ap_deleted} agentic_process records")
