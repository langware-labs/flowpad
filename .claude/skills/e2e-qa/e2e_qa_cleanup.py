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
- Outside that legacy HOME, only assets whose names match a RESERVED TEST
  PATTERN (``e2etest-`` prefix, or one of the retired generator families in
  ``_LEGACY_JUNK``) are removed, and only from the four asset roots below
  (skills/agents/workflows/whiteboards); all other real user and
  launched-instance data is untouched.
- NEVER kills processes. It is filesystem-only and safe to run any time no
  pytest process is mid-run.

Usage:
    python .claude/skills/e2e-qa/e2e_qa_cleanup.py [--dry-run]

Exit code 0 always (cleanup is best-effort and must never block the cycle).
"""

from __future__ import annotations

import os
import re
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


# Retired test-generator families. These predate the reserved ``e2etest-`` marker,
# so no prefix sweep matches them and the tests that minted them are gone from the
# tree — nothing would ever reap them again. Each pattern is anchored and paired
# with a digit/index tail so it cannot match a hand-named user asset.
#
# TEMPORARY — do not extend. This is a finite backstop for junk that ALREADY exists
# on developer machines; it cannot catch the next leak, and adding to it would be
# treating the symptom. Every new live-entity test names its entities through
# ``testEntityName`` (ui/tests/_cleanup.ts), which carries the ``e2etest-`` marker
# the prefix sweep above already handles. Once these families are gone from every
# machine that matters, delete this list — a name-pattern guess is strictly weaker
# than the marker, and weaker still than asking the backend which rows have no
# asset behind them.
#
# Sources, where still identifiable:
#   scan_skill_* / index_skill_* / full_cycle_skill_* / byte_stats_skill
#       -> ui/tests/api/fs_records_scan_search.test.ts (pre-``testEntityName``)
#   fast-scan-* / fast-index-* / per-type-i-* / monotonic-scan-*
#       -> tests/long_tests/test_progress_report_fast.py
#   p<N>-<digits> / probe2-<digits>  -> ad-hoc probe runs
_LEGACY_JUNK = (
    r"(?:scan|index|full_cycle)_skill_\d+",
    r"byte_stats_skill",
    r"(?:fast-scan|fast-index|per-type-i|monotonic-scan)-\d+(?:-\d+)?",
    r"p\d+-\d+(?:-\d+)?",
    r"probe2-\d+",
)
_LEGACY_JUNK_RE = re.compile(r"^(?:" + "|".join(_LEGACY_JUNK) + r")$")

# Asset roots a leaked live test can materialise into. ``skills`` holds folders;
# ``agents`` holds ``<name>.md`` files; ``workflows`` holds ``<name>.js`` files;
# ``whiteboards`` holds folders.
_ASSET_ROOTS = ("skills", "agents", "workflows", "whiteboards")


def _is_test_artifact(name: str) -> bool:
    """True iff ``name`` is unambiguously test-generated (never a user asset)."""
    stem = Path(name).stem
    return stem.startswith("e2etest-") or bool(_LEGACY_JUNK_RE.match(stem))


def _purge_test_assets(dry_run: bool = False) -> int:
    """Delete leftover test assets from the REAL asset roots.

    The api/headless/hub tiers create entities through the production SDK against
    a LIVE backend running under the real HOME, so a run that dies mid-test (or
    predates its tier's ``installCleanup``) strands the on-disk asset. Every
    backend then re-indexes it on bootstrap, which both reds the leak tripwire on
    artifacts this run never created and pollutes the user's asset pickers and
    the Claude Code skill listing.

    Scoped HARD to names ``_is_test_artifact`` accepts — never a real user asset.
    """
    homes = [Path.home()]
    inst = Path.home() / ".flow" / "instances"
    if inst.is_dir():
        homes += [p / "home" for p in inst.glob("*") if p.is_dir()]

    roots = [h / ".claude" / sub for h in homes for sub in _ASSET_ROOTS]

    removed = 0
    for root in roots:
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if not _is_test_artifact(entry.name):
                continue
            if dry_run:
                print(f"[e2e-qa-cleanup] would remove {entry}")
            elif entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink(missing_ok=True)
            removed += 1
    print(f"[e2e-qa-cleanup] {'would remove' if dry_run else 'removed'} {removed} test asset(s)")
    return removed


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    rc = cleanup(dry_run=dry)
    _purge_test_assets(dry_run=dry)
    sys.exit(rc)
