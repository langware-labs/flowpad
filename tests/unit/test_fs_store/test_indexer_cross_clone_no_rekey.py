"""RCA capture: dedup-on-adopt must NOT re-key an authored, committed id when the
"incumbent" is a SEPARATE checkout/clone of the same repo (a legitimately shared
git-committed id), as opposed to a real intra-tree ``cp -r`` copy.

Real incident (2026-07-12): the prod indexer had markdown rows anchored into a
sibling git worktree (``flowpad-os-notif/README.md``) carrying the same committed
frontmatter id as the main checkout's ``README.md``. Re-indexing the main checkout
saw that id "already at a different still-present path", classified the authored
source file as a copy, minted a fresh v4 and WROTE IT BACK — mass-re-minting 293
tracked ``.md`` ids. Committed ids must be minted once and never touched.

Narrowest reproduction: two distinct roots (two clones), each with a file bearing
the SAME committed v5 id. Index clone A (DB anchors id -> A). Index clone B. B's
committed id must survive.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.indexer import IndexerOptions
from tests.unit.test_fs_store._md_harness import (
    MD_OPTS as _OPTS,
    fm_id as _fm_id,
    md_indexer as _md_indexer,
)

# A real, valid v5 entity id (version nibble 5) — stands in for a committed id
# that git tracks identically across every clone of the repo.
_COMMITTED_ID = "4a1f6926-a591-55ab-94d7-5abbfdd3d6db"


def _seed_clone(root: Path) -> Path:
    """A checkout root with ``.claude/docs/a.md`` carrying the committed id."""
    docs = root / "proj" / ".claude" / "docs"
    docs.mkdir(parents=True)
    md = docs / "a.md"
    md.write_text(f"---\nid: {_COMMITTED_ID}\n---\n\n# a\nbody\n", encoding="utf-8")
    return md


@pytest.mark.asyncio
async def test_second_clone_is_not_rekeyed(tmp_path: Path) -> None:
    await get_db_driver().delete_entities_by_type("markdown")

    a = _seed_clone(tmp_path / "cloneA")
    b = _seed_clone(tmp_path / "cloneB")
    assert _fm_id(a) == _COMMITTED_ID and _fm_id(b) == _COMMITTED_ID

    # Index clone A first — DB now anchors the committed id to A's path.
    await _md_indexer(tmp_path / "cloneA" / "proj").index(IndexerOptions(**_OPTS))
    assert _fm_id(a) == _COMMITTED_ID, "the first checkout keeps its committed id"

    # Index clone B. B is a legitimate separate checkout of the same repo — the
    # shared committed id is NOT a `cp -r` copy and must never be rewritten.
    await _md_indexer(tmp_path / "cloneB" / "proj").index(IndexerOptions(**_OPTS))

    assert _fm_id(b) == _COMMITTED_ID, (
        "cross-clone: the second checkout's committed frontmatter id was re-minted "
        "(dedup-on-adopt misclassified an authored source file as a copy)"
    )
