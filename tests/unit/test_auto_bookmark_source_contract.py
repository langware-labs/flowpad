"""The `auto` bookmark source is spelled the same on both sides of the wire.

`bookmarkInScope` (ui/src/lib/bookmark-scope.ts) decides whether a favorites row
is project content or a personal favorite by comparing `Bookmark.source` against
the TS constant; `mint_auto_favorite` writes that value from the Python one. The
two are plain string literals in different languages, so a rename on either side
would silently stop matching — no compile error, no runtime error, just every
auto row misclassified and the duplicate "Auto" folder back.

Same reason the repo pins its other cross-language shapes with a contract test
(tests/fixtures/dock_address_contract.json, and the v4/v5 entity-id regex that
must agree between `is_valid_entity_id` and `ts_sdk/src/models/TypeId.ts`).
"""
from __future__ import annotations

import re
from pathlib import Path

from flow_sdk.builtin.bookmark import AUTO_SOURCE

TS_FILE = Path(__file__).resolve().parents[2] / "ts_sdk/src/entities/bookmark.ts"


def test_ts_auto_bookmark_source_matches_python() -> None:
    declaration = re.search(
        r"export const AUTO_BOOKMARK_SOURCE\s*=\s*['\"]([^'\"]+)['\"]",
        TS_FILE.read_text(encoding="utf-8"),
    )
    assert declaration, f"AUTO_BOOKMARK_SOURCE is not declared in {TS_FILE.name}"
    assert declaration.group(1) == AUTO_SOURCE
