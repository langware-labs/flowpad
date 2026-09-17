#!/usr/bin/env python3
"""Extract toplog tags referenced in code and reconcile them with the catalog.

The mechanical half of the `toplog` skill's `scan` (and a helper for `run` /
`learn`). Walks the source trees, pulls the first argument of every
``toplog.log(...)`` / ``toplog.isOn(...)`` / ``toplog.is_on(...)`` call (a string
literal, a ``[...]`` array of string literals, or a constant name bound to a
string literal anywhere in the scanned trees) and prints each tag with its
``file:line`` locations. Calls are matched over the whole file text, so a call
whose tag sits on the line after ``toplog.log(`` is found too.

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

# toplog.<method>( <first-arg> ...   where first-arg is "x" / 'x' / [ ... ] / NAME
_CALL = re.compile(
    r"toplog\.(?:log|is_on|isOn)\(\s*(\[[^\]]*\]|\"[^\"]*\"|'[^']*'|[A-Za-z_][\w.]*)",
)
# ``NAME = "tag"`` (Python) / ``const NAME = 'tag'`` (TS) — resolves a constant arg.
_CONST = re.compile(
    r"^\s*(?:export\s+)?(?:const\s+|let\s+)?([A-Za-z_]\w*)\s*(?::\s*[\w\[\]]+\s*)?=\s*[\"']([^\"']+)[\"']",
    re.MULTILINE,
)
_STR = re.compile(r"""["']([^"']+)["']""")
# ``### <tag>`` headings define the catalog registry.
_HEADING = re.compile(r"###\s+(\S+)")


def _tags_in_arg(arg: str) -> list[str]:
    """Pull tag strings from a captured first argument (literal or array)."""
    return _STR.findall(arg)


def _source_files(root: Path):
    for rel in SCAN_DIRS:
        base = root / rel
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if path.suffix not in SCAN_EXTS or not path.is_file():
                continue
            if "node_modules" in path.parts:
                continue
            rel_str = str(path.relative_to(root))
            if any(ex in rel_str for ex in EXCLUDE_SUBSTRINGS):
                continue
            try:
                yield rel_str, path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue


def scan_code(root: Path) -> dict[str, list[str]]:
    """Map tag -> sorted list of "relpath:line" where it is referenced."""
    files = list(_source_files(root))
    found: dict[str, list[str]] = {}
    calls: list[tuple[str, int, str]] = []
    # Constants: a file's own binding wins; otherwise any unambiguous binding.
    local_consts: dict[str, dict[str, str]] = {}
    global_consts: dict[str, set[str]] = {}
    for rel_str, text in files:
        for m in _CONST.finditer(text):
            local_consts.setdefault(rel_str, {})[m.group(1)] = m.group(2)
            global_consts.setdefault(m.group(1), set()).add(m.group(2))
        for m in _CALL.finditer(text):
            line = text.count("\n", 0, m.start()) + 1
            calls.append((rel_str, line, m.group(1)))
    for rel_str, line, arg in calls:
        if arg[0] in "[\"'":
            tags = _tags_in_arg(arg)
        else:
            name = arg.rsplit(".", 1)[-1]
            value = local_consts.get(rel_str, {}).get(name)
            if value is None and len(global_consts.get(name, ())) == 1:
                value = next(iter(global_consts[name]))
            tags = [value] if value else []
        for tag in tags:
            found.setdefault(tag, []).append(f"{rel_str}:{line}")
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
