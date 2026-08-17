"""`TypeInfo.mint_entity_id` is the ONLY way to resolve a filesystem asset's id.

The seam was open-coded as ``extract_id(...) or mint_id(...)`` in eight places.
That expression means "use the id in the file, otherwise invent one" — which
forks the entity whenever a rewrite has wiped the carrier. It was already fixed
ONCE, at a single call site, by threading ``proposed_id`` through
``discover_record_by_path``; the index walk never got the memo and kept forking
for another release.

A parameter only protects the callers who remember to pass it. These tests
protect the ones who don't:

1. the legacy methods are GONE, so the old shape cannot be written at all;
2. no module re-grows a per-type ``*_id()`` minter beside its stable-key fn.

Both guards are self-tested, because a guard that cannot fail is not a guard.
"""
from __future__ import annotations

import ast
from pathlib import Path

from flow_sdk.fs_store.schema_registry import TypeInfo

FLOW_SDK = Path(__file__).resolve().parents[3] / "flow_sdk"

#: Module-level ``*_id`` helpers allowed to reach ``mint_uuid`` directly.
#: Each entry needs a REASON — "it was already there" is how the last 20 got in.
_PER_TYPE_MINTER_ALLOWLIST = {
    # Child rows of a dataset. An example/slot has no FSRef and no TypeInfo of
    # its own, so there is no seam to route through — the id is derived from
    # the owning dataset's id plus a within-file key.
    ("dataset.py", "_example_id"),
    ("dataset.py", "_slot_id"),
    # The task type's folder-name fallback, the last leg of
    # ``_task_id_from_fields``' reader precedence (capsule → frontmatter →
    # folder name). Mirrors the TypeInfo reader order rather than competing
    # with it; changing it would move every transitional task id.
    ("task.py", "_mint_task_id"),
    # Provider-owned journals: the run id IS the natural key and doubles as the
    # type's ``id_stable_key_fn``. Read-only source, so nothing is ever stamped.
    ("workflow_run.py", "workflow_run_id"),
    # Read-only derives for request handlers / non-indexer callers. Both are
    # scheduled to fold into ``mint_entity_id(..., derive=True)``; the fold
    # MOVES ids for capsule-stamped docs, so it ships on its own.
    ("markdown.py", "markdown_id"),
    ("subagent.py", "subagent_peek_entity_id"),
}


def _is_call_to(node: ast.AST, name: str) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == name
    )


def test_the_legacy_seam_methods_no_longer_exist() -> None:
    """The load-bearing assertion.

    An AST lint that matches by attribute name passes VACUOUSLY once the names
    are gone — so the real guarantee is that they cannot come back. If someone
    re-adds `mint_id`, this fails before the pattern lint has to.
    """
    for gone in ("mint_id", "extract_id", "resolve_id", "_mint_from"):
        assert not hasattr(TypeInfo, gone), (
            f"TypeInfo.{gone} is back. Identity resolution has exactly one seam, "
            "`mint_entity_id`; a second entry point is how this bug survived its "
            "first fix."
        )
    assert hasattr(TypeInfo, "mint_entity_id")


def _carrier_or_mint_sites(root: Path) -> list[str]:
    """Any ``<x>.<read>(...) or <y>.<mint>(...)`` identity shape under ``root``."""
    reads = {"extract_id", "peek_entity_id", "mint_entity_id"}
    mints = {"mint_id", "mint_entity_id", "_derive"}
    hits: list[str] = []
    for path in root.rglob("*.py"):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.BoolOp) or not isinstance(node.op, ast.Or):
                continue
            if len(node.values) != 2:
                continue
            if any(_is_call_to(node.values[0], r) for r in reads) and any(
                _is_call_to(node.values[1], m) for m in mints
            ):
                hits.append(f"{path}:{node.lineno}")
    return sorted(hits)


def test_no_carrier_or_mint_pairs_remain() -> None:
    sites = _carrier_or_mint_sites(FLOW_SDK)
    assert sites == [], (
        "identity must be resolved by ONE call to TypeInfo.mint_entity_id, which "
        "consults the row that already owns the path. A read-then-mint pair skips "
        "that and forks the entity when a rewrite has wiped the carrier. Found at:\n  "
        + "\n  ".join(sites)
    )


def test_the_pair_detector_actually_detects(tmp_path: Path) -> None:
    (tmp_path / "probe.py").write_text(
        "rid = info.mint_entity_id(ref) or info.mint_entity_id(ref, derive=True)\n",
        encoding="utf-8",
    )
    assert len(_carrier_or_mint_sites(tmp_path)) == 1


def _per_type_minters(root: Path) -> list[str]:
    """Module-level ``*_id`` functions that reach ``mint_uuid`` themselves.

    Each of these is a parallel identity policy for a type that already has one
    in its ``TypeInfo``. Twenty-three of them accumulated unnoticed, all dead.
    """
    hits: list[str] = []
    for path in sorted(root.glob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            continue
        for node in tree.body:
            if not isinstance(node, ast.FunctionDef) or not node.name.endswith("_id"):
                continue
            if (path.name, node.name) in _PER_TYPE_MINTER_ALLOWLIST:
                continue
            for inner in ast.walk(node):
                if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Name) and inner.func.id == "mint_uuid":
                    hits.append(f"{path.name}:{node.lineno} {node.name}")
                    break
    return sorted(hits)


def test_no_per_type_minters_regrow() -> None:
    sites = _per_type_minters(FLOW_SDK / "fs_store" / "indexer" / "functions")
    assert sites == [], (
        "a per-type `*_id()` helper that calls mint_uuid is a second identity "
        "policy for a type whose TypeInfo already has one — they drift, and every "
        "one of them was dead code by the time it was found. Use "
        "TypeInfo.mint_entity_id, or add an id_stable_key_fn and let the seam mint. "
        "Found:\n  " + "\n  ".join(sites)
    )


def test_the_minter_detector_actually_detects(tmp_path: Path) -> None:
    (tmp_path / "probe.py").write_text(
        "def thing_id(ref):\n    return mint_uuid(str(ref))\n", encoding="utf-8"
    )
    assert len(_per_type_minters(tmp_path)) == 1
