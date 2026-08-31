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
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.markdown import markdown_flat_fn
from flow_sdk.fs_store.record_types import RecordType
from tests.unit.test_fs_store._md_harness import (
    MD_OPTS as _OPTS,
)
from tests.unit.test_fs_store._md_harness import (
    fm_id as _fm_id,
)
from tests.unit.test_fs_store._md_harness import (
    md_indexer as _md_indexer,
)

# A real, valid v5 entity id (version nibble 5) — stands in for a committed id
# that git tracks identically across every clone of the repo.
_COMMITTED_ID = "4a1f6926-a591-55ab-94d7-5abbfdd3d6db"


def _seed_clone(root: Path) -> Path:
    """A checkout root with ``docs/a.md`` carrying the committed id."""
    docs = root / "proj" / "docs"
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


@pytest.mark.asyncio
async def test_cowalked_clones_in_one_scan_are_not_rekeyed(tmp_path: Path) -> None:
    """The all-projects scan the single-run test misses: TWO sibling checkouts are
    walked as roots in ONE ``index()`` run (prod indexes every registered project
    cwd together). Both hold the same committed id, so both are IN-SCOPE — the
    ``_incumbent_in_run_scope`` guard passes for both and dedup-on-adopt re-keys the
    second co-walked clone, re-minting its git-tracked frontmatter. This is the real
    2026-07-12 mass re-mint (the machine had 6 sibling checkouts of the same repo,
    each re-stamped to a distinct fresh v4)."""
    await get_db_driver().delete_entities_by_type("markdown")

    a = _seed_clone(tmp_path / "cloneA")
    b = _seed_clone(tmp_path / "cloneB")
    assert _fm_id(a) == _COMMITTED_ID and _fm_id(b) == _COMMITTED_ID

    # ONE indexer, BOTH clones as roots — the all-projects scan. MD_OPTS carries no
    # ``roots`` override, so the dedup scope is ``self._roots`` = both clones, and
    # each clone's committed id is "an incumbent within run scope" for the other.
    idx = FSIndexer()
    idx.add_root(FSRef(tmp_path / "cloneA" / "proj", record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_root(FSRef(tmp_path / "cloneB" / "proj", record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)
    await idx.index(IndexerOptions(**_OPTS))

    assert _fm_id(a) == _COMMITTED_ID and _fm_id(b) == _COMMITTED_ID, (
        "co-walked clones in ONE all-projects scan had a committed frontmatter id "
        "re-minted (dedup-on-adopt guard defeated — both clones are in run scope): "
        f"A={_fm_id(a)} B={_fm_id(b)} committed={_COMMITTED_ID}"
    )
