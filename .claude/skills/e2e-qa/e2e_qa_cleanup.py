#!/usr/bin/env python3
"""e2e-qa startup cleanup — wipe legacy test-instance scratch.

Older pytest runs shared the sandbox HOME ``<os-tempdir>/flowpad_test_home``.
Current runs use a unique ``<FLOWPAD_TEMP_DIR>/pytest-*/home`` owned and removed
by that process, but the retired shared directory may still contain polluted
singleton instances and stale artifacts from earlier runs. Remove that legacy
scratch before a QA cycle so it cannot contaminate tools that still inspect it.

This script removes that scratch so every QA cycle starts pristine. It is
wired into the e2e-qa skill STARTUP (see SKILL.md → "Startup: clean old").

SAFETY (non-negotiable):
- Only ever operates on the retired directory literally named
  ``flowpad_test_home`` under the OS temp dir. Any other target is refused.
- NEVER globs or deletes the live per-process ``pytest-*`` roots.
- Outside that legacy HOME, only directories whose names begin with the
  reserved ``e2etest-`` prefix are removed from skill roots; all other real
  user and launched-instance data is untouched.
- NEVER kills processes. It is filesystem-only and safe to run any time no
  pytest process is mid-run.

Usage:
    python .claude/skills/e2e-qa/e2e_qa_cleanup.py [--dry-run]

Exit code 0 always (cleanup is best-effort and must never block the cycle).
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path


def _legacy_test_home() -> Path:
    """The retired shared pytest HOME used before per-process isolation."""
    return Path(tempfile.gettempdir()) / "flowpad_test_home"


def _is_safe_target(path: Path) -> bool:
    """Refuse anything that is not <os-tempdir>/flowpad_test_home.

    Guards against ever deleting the real user home or an arbitrary path.
    """
    tmp = Path(tempfile.gettempdir()).resolve()
    try:
        resolved = path.resolve()
    except OSError:
        return False
    return resolved.name == "flowpad_test_home" and resolved.parent == tmp


def cleanup(dry_run: bool = False) -> int:
    home = _legacy_test_home()
    if not _is_safe_target(home):
        print(f"[e2e-qa-cleanup] REFUSED unsafe target: {home}")
        return 0
    if not home.exists():
        print(f"[e2e-qa-cleanup] nothing to clean — {home} does not exist")
        return 0

    instances = home / ".flow" / "instances"
    inst_dirs = sorted(p for p in instances.glob("*") if p.is_dir()) if instances.is_dir() else []
    test_dirs = [p for p in inst_dirs if p.name.startswith("test-")]

    # Total size for reporting (best-effort).
    def _du(p: Path) -> int:
        total = 0
        for root, _dirs, files in os.walk(p):
            for f in files:
                try:
                    total += (Path(root) / f).stat().st_size
                except OSError:
                    pass
        return total

    size = _du(home)
    print(
        f"[e2e-qa-cleanup] target={home}\n"
        f"  instances={len(inst_dirs)} (test-*={len(test_dirs)}, "
        f"other={[p.name for p in inst_dirs if not p.name.startswith('test-')]})\n"
        f"  size={size / 1_000_000:.1f}MB"
    )

    if dry_run:
        print("[e2e-qa-cleanup] --dry-run: no changes made")
        return 0

    # Wipe only the retired shared HOME. Current pytest homes are children of
    # unique run roots and are removed by their owning process's atexit hook.
    shutil.rmtree(home, ignore_errors=True)

    print(f"[e2e-qa-cleanup] removed {len(inst_dirs)} instance dirs, freed ~{size / 1_000_000:.1f}MB")
    return 0


def _purge_e2etest_skills(dry_run: bool = False) -> int:
    """Delete leftover ``e2etest-skill-*`` skill folders from real skill dirs.

    The api-tier leak tripwire (tests/_cleanup.ts) sweeps the ``skill`` type and
    FAILS if any ``e2etest-*`` skill survives teardown. Prior runs that died
    mid-test leave these folders behind in the REAL ``~/.claude/skills`` (and per
    instance homes), where every backend re-indexes them on bootstrap — so the
    tripwire keeps failing on artifacts this run never created. They are
    unambiguous test artifacts (the ``e2etest-`` name prefix), safe to remove.

    Scoped HARD to dirs whose basename starts with ``e2etest-`` — never touches
    a real user skill.
    """
    roots = [Path.home() / ".claude" / "skills"]
    inst = Path.home() / ".flow" / "instances"
    if inst.is_dir():
        roots += [p / "home" / ".claude" / "skills" for p in inst.glob("*") if p.is_dir()]

    removed = 0
    for root in roots:
        if not root.is_dir():
            continue
        for d in root.glob("e2etest-*"):
            if not d.name.startswith("e2etest-"):  # belt-and-suspenders
                continue
            if dry_run:
                print(f"[e2e-qa-cleanup] would remove skill artifact {d}")
            else:
                shutil.rmtree(d, ignore_errors=True) if d.is_dir() else d.unlink(missing_ok=True)
            removed += 1
    print(f"[e2e-qa-cleanup] {'would remove' if dry_run else 'removed'} {removed} e2etest-* skill artifact(s)")
    return removed


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    rc = cleanup(dry_run=dry)
    _purge_e2etest_skills(dry_run=dry)
    sys.exit(rc)
