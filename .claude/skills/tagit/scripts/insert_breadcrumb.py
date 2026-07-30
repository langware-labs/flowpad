#!/usr/bin/env python3
"""Insert a breadcrumb `tag` capsule on top of a test.

The mechanical half of the `tagit` skill. Resolves the anchor line for a test
and writes the capsule through the PRODUCTION carrier
(``LineCommentCapsule.write_at``), so placement, newline style, locking, atomic
replacement and insert-vs-replace all behave exactly like identity-capsule
injection — the only differences being the payload and the line.

Placement rules this enforces, none of which are safe to leave to a model:

* **Column 0.** An indented capsule raises inside the parser, and
  ``scan_code_capsules`` swallows that — the whole FILE silently disappears
  from ``flow tag get``. For a method inside a ``class Test...`` the anchor is
  therefore hoisted to the class statement, never a line in its body.
* **Above the decorators.** ``@pytest.mark.…`` lines belong to the test, so the
  capsule goes above the first one.
* **Merge, never stack.** A breadcrumb already anchored on this test is read
  first and its tags are merged, so re-running adds a tag instead of replacing
  the file's existing knowledge.

Usage:
    python insert_breadcrumb.py --file tests/unit/test_x.py \\
        --test test_catchup_pulls_backlog \\
        --tag breadcrumb.test.catchup_login.rules \\
        --note "FAILING? read this tag's rules before editing"

Exit codes: 0 written (or already correct); 2 bad arguments / test not found.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT))

from flow_sdk.capsules.data import CapsuleData  # noqa: E402
from flow_sdk.capsules.line_comment import LineCommentCapsule  # noqa: E402
from flow_sdk.tags.grammar import normalize_tag  # noqa: E402

CAPSULE_NAME = "tag"


def _fail(message: str) -> "None":
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def resolve_anchor(lines: list[str], test: str) -> int:
    """1-indexed line the capsule must sit above, at column 0.

    Walks up from the ``def`` over decorators; if the def is indented (a method
    on a test class) the anchor is hoisted to the enclosing column-0 statement
    so the block never lands inside a class body.
    """
    pattern = re.compile(rf"^(\s*)(?:async\s+)?def\s+{re.escape(test)}\s*\(")
    index = next((i for i, line in enumerate(lines) if pattern.match(line)), None)
    if index is None:
        _fail(f"no def {test}(...) in the file")

    if pattern.match(lines[index]).group(1):  # indented → hoist to the owner
        index = next(
            (
                i
                for i in range(index, -1, -1)
                if lines[i].strip() and not lines[i][:1].isspace()
            ),
            None,
        )
        if index is None:
            _fail(f"{test} is indented but has no column-0 owner to anchor above")

    while index > 0 and lines[index - 1].lstrip().startswith("@"):
        index -= 1
    return index + 1


def existing_tags(capsule: LineCommentCapsule, anchor: int) -> dict:
    """Tags already carried by the block anchored on this test, if any."""
    for block in capsule.read_all(CAPSULE_NAME):
        if block.end_line == anchor - 1 or block.line == anchor:
            carried = block.data.data.get("tags")
            return dict(carried) if isinstance(carried, dict) else {}
    return {}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True, help="Path to the test file")
    parser.add_argument("--test", required=True, help="Test function name")
    parser.add_argument("--tag", required=True, help="Tag, e.g. breadcrumb.test.foo.rules")
    parser.add_argument("--note", required=True, help="Imperative one-liner shown by `flow tag get`")
    args = parser.parse_args()

    path = Path(args.file).expanduser()
    if not path.is_file():
        _fail(f"no such file: {path}")
    try:
        tag = normalize_tag(args.tag)
    except (TypeError, ValueError) as exc:
        _fail(f"invalid tag {args.tag!r}: {exc}")
    if not args.note.strip():
        _fail("--note is the only thing `flow tag get` shows for a code site; it cannot be empty")

    lines = path.read_text(encoding="utf-8").splitlines()
    anchor = resolve_anchor(lines, args.test)

    capsule = LineCommentCapsule(path)
    tags = existing_tags(capsule, anchor)
    tags[tag] = args.note.strip()
    capsule.write_at(CAPSULE_NAME, CapsuleData(1, {"tags": tags}), line=anchor)

    placed = next(
        block for block in capsule.read_all(CAPSULE_NAME) if tag in (block.data.data.get("tags") or {})
    )
    print(f"{path}:{placed.line} {CAPSULE_NAME} -> {', '.join(sorted(tags))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
