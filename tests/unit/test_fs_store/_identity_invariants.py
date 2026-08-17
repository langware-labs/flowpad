"""The invariant identity tests exist to protect: one path = one live row.

``asset_ref`` is globally unique — one entity per file path across all types
(``Entity.get_by_asset_ref``). That is assumed by every path→entity lookup but
was never enforced, which is how a capsule wipe could fork a document into four
entities in seventy seconds.

Call :func:`assert_one_live_row_per_path` at the end of any test that indexes,
re-indexes, copies, moves or rewrites an asset. It is the exact inverse of
``_same_path_dupe_groups``: that function finds the duplicate groups, this one
asserts there are none.
"""
from __future__ import annotations

from collections import defaultdict

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.path_utils import canonical_posix_path


async def live_rows_by_path(*types: str) -> dict[tuple[str, str], list[str]]:
    """``{(type, canonical_path): [entity_id, ...]}`` for every row with a path."""
    driver = get_db_driver()
    out: dict[tuple[str, str], list[str]] = defaultdict(list)
    for type_name in types:
        rows = await driver.list_entity_sources_by_type(type_name)
        for entity_id, src in (rows or {}).items():
            raw = src[0] if src else None
            if not raw:
                continue
            try:
                key = canonical_posix_path(raw)
            except (OSError, ValueError):
                key = str(raw)
            out[(type_name, key)].append(str(entity_id))
    return dict(out)


async def assert_one_live_row_per_path(*types: str) -> None:
    """Fail with a full diagnostic dump when any path is claimed by >1 row."""
    forked = {k: v for k, v in (await live_rows_by_path(*types)).items() if len(v) > 1}
    if not forked:
        return
    detail = "\n".join(f"  {t} {path}\n    -> {sorted(ids)}" for (t, path), ids in sorted(forked.items()))
    raise AssertionError(
        f"{len(forked)} path(s) claimed by more than one live row — the identity fork is back:\n{detail}"
    )
