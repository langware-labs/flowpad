#!/usr/bin/env python3
"""Extract toplog tags referenced in code and reconcile them with the catalog.

The mechanical half of the `toplog` skill's `scan` (and a helper for `run` /
`learn`). Walks the source trees, pulls the first argument of every
``toplog.log(...)`` / ``toplog.isOn(...)`` / ``toplog.is_on(...)`` call (a string
literal or a ``[...]`` array of string literals), and prints each tag with its
``file:line`` locations.

Given the catalog (``tags.md``), it also prints the two diff sets:
  * UNDOCUMENTED — referenced in code but absent from the catalog.
  * STALE        — catalogued but no longer referenced in code.

Usage:
    python scan_tags.py [repo_root]

``repo_root`` defaults to the repository this script lives in (four levels up:
.claude/skills/toplog/scripts/ -> repo root).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

# Directories scanned for call sites, relative to repo root.
SCAN_DIRS = ["flow_sdk", "tests", "ui/src", "ts_sdk/src"]
SCAN_EXTS = {".py", ".ts", ".tsx"}

# Skip the toplog implementation + its own unit tests — they reference tags
# mechanically (or as fixtures), not as real trace points.
EXCLUDE_SUBSTRINGS = (
    "flow_sdk/toplog.py",
    "ts_sdk/src/services/toplog.ts",
    "tests/unit/test_toplog/",
    "ui/tests/unit/toplog.test.ts",
)

# toplog.<method>( <first-arg> ...   where first-arg is "x" / 'x' / [ ... ]
_CALL = re.compile(
    r"toplog\.(?:log|is_on|isOn)\(\s*(\[[^\]]*\]|\"[^\"]*\"|'[^']*')",
)
_STR = re.compile(r"""["']([^"']+)["']""")
# ``### <tag>`` headings define the catalog registry.
_HEADING = re.compile(r"###\s+(\S+)")


def _tags_in_arg(arg: str) -> list[str]:
    """Pull tag strings from a captured first argument (literal or array)."""
    return _STR.findall(arg)


def scan_code(root: Path) -> dict[str, list[str]]:
    """Map tag -> sorted list of "relpath:line" where it is referenced."""
    found: dict[str, list[str]] = {}
    for rel in SCAN_DIRS:
        base = root / rel
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if path.suffix not in SCAN_EXTS or not path.is_file():
                continue
            rel_str = str(path.relative_to(root))
            if any(ex in rel_str for ex in EXCLUDE_SUBSTRINGS):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            for i, line in enumerate(text.splitlines(), 1):
                for m in _CALL.finditer(line):
                    for tag in _tags_in_arg(m.group(1)):
                        found.setdefault(tag, []).append(f"{rel_str}:{i}")
    return found


def catalog_tags(catalog: Path) -> set[str]:
    """Registry = every ``### <tag>`` heading in tags.md."""
    if not catalog.exists():
        return set()
    tags: set[str] = set()
    for line in catalog.read_text(encoding="utf-8").splitlines():
        m = _HEADING.match(line)
        if m and m.group(1) != "<tag>":  # ignore the literal template heading
            tags.add(m.group(1))
    return tags


def main(argv: list[str]) -> int:
    here = Path(__file__).resolve()
    default_root = here.parents[4]  # scripts/ -> toplog/ -> skills/ -> .claude/ -> repo
    root = Path(argv[1]).resolve() if len(argv) > 1 else default_root
    catalog = here.parent.parent / "tags.md"

    code = scan_code(root)
    cat = catalog_tags(catalog)

    print(f"# toplog tag scan — root: {root}\n")
    if code:
        print("## Tags referenced in code")
        for tag in sorted(code):
            locs = ", ".join(code[tag])
            print(f"  {tag}: {locs}")
    else:
        print("## Tags referenced in code\n  (none)")

    undocumented = sorted(set(code) - cat)
    stale = sorted(cat - set(code))

    print("\n## Reconciliation vs catalog (tags.md)")
    print(f"  catalogued: {', '.join(sorted(cat)) or '(none)'}")
    print(f"  UNDOCUMENTED (in code, not catalogued): {', '.join(undocumented) or '(none)'}")
    print(f"  STALE (catalogued, not in code):        {', '.join(stale) or '(none)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
