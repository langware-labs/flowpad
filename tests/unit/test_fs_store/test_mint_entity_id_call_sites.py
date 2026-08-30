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
import functools
from pathlib import Path

import pytest

from flow_sdk.fs_store.schema_registry import TypeInfo

FLOW_SDK = Path(__file__).resolve().parents[3] / "flow_sdk"

#: Module-level ``*_id`` helpers allowed to reach ``mint_uuid`` directly.
#: Each entry needs a REASON — "it was already there" is how the last 20 got in.
_PER_TYPE_MINTER_ALLOWLIST = {
    # A dataset's example rows. An example has no FSRef and no TypeInfo of its
    # own, so there is no seam to route through — the id is derived from the
    # owning dataset's id plus a within-file key. (Slot artifacts used to need a
    # second entry here; a row is plain JSON now, and a value has no id.)
    ("dataset.py", "_example_id"),
    # The task type's folder-name fallback, the last leg of
    # ``_task_id_from_fields``' reader precedence (capsule → frontmatter →
    # folder name). Mirrors the TypeInfo reader order rather than competing
    # with it; changing it would move every transitional task id.
    ("task.py", "_mint_task_id"),
    # Provider-owned journals: the run id IS the natural key and doubles as the
    # type's ``id_stable_key_fn``. Read-only source, so nothing is ever stamped.
    ("workflow_run.py", "workflow_run_id"),
    # A read-only derive for request handlers. Still listed because its
    # import-order fallback reaches the historic derive; the main path is the
    # seam. (``markdown_id`` no longer needs an entry — it delegates outright.)
    ("subagent.py", "subagent_peek_entity_id"),
}


@functools.lru_cache(maxsize=None)
def _trees(root: Path, recursive: bool = True) -> tuple[tuple[Path, ast.Module], ...]:
    """Parse every module under ``root`` once, shared by all three detectors.

    Cached: the full-``flow_sdk`` walk is ~1100 files, and the subtree checks
    below would otherwise re-parse a couple hundred of them a second time.
    """
    paths = sorted(root.rglob("*.py") if recursive else root.glob("*.py"))
    out = []
    for path in paths:
        try:
            out.append((path, ast.parse(path.read_text(encoding="utf-8"))))
        except (OSError, SyntaxError):
            continue
    return tuple(out)


def _calls_to(node: ast.AST, *names: str) -> bool:
    """True when ``node`` is a call to any of ``names`` (``x.name(...)``)."""
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in names
    )


def test_the_legacy_seam_methods_no_longer_exist() -> None:
    """The load-bearing assertion.

    An AST lint that matches by attribute name passes VACUOUSLY once the names
    are gone — so the real guarantee is that they cannot come back. If someone
    re-adds `mint_id`, this fails before the pattern lint has to.
    """
    for gone in ("mint_id", "extract_id", "resolve_id", "_mint_from", "_observe", "_derive", "capsule_target_for"):
        assert not hasattr(TypeInfo, gone), (
            f"TypeInfo.{gone} is back. Identity resolution has exactly one seam, "
            "`mint_entity_id`; a second entry point is how this bug survived its "
            "first fix."
        )
    assert hasattr(TypeInfo, "mint_entity_id") and hasattr(TypeInfo, "read_id")


def _carrier_or_mint_sites(root: Path) -> list[str]:
    """Any ``<x>.<read>(...) or <y>.<mint>(...)`` identity shape under ``root``."""
    reads = ("extract_id", "peek_entity_id", "read_id", "mint_entity_id")
    mints = ("mint_id", "mint_entity_id")
    hits: list[str] = []
    for path, tree in _trees(root):
        for node in ast.walk(tree):
            if not isinstance(node, ast.BoolOp) or not isinstance(node.op, ast.Or):
                continue
            if len(node.values) != 2:
                continue
            if _calls_to(node.values[0], *reads) and _calls_to(node.values[1], *mints):
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


def _per_type_minters(root: Path) -> list[str]:
    """Module-level ``*_id`` functions that reach ``mint_uuid`` themselves.

    Each of these is a parallel identity policy for a type that already has one
    in its ``TypeInfo``. Twenty-three of them accumulated unnoticed, all dead.
    """
    hits: list[str] = []
    for path, tree in _trees(root, recursive=False):
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


#: Raw ``uuid4``/``uuid5`` allowed under the identity-critical tree. Every entry
#: carries a REASON; "it was already there" is how the last twenty got in.
_RAW_UUID_ALLOWLIST = {
    # `content_fingerprint` — a content hash over (type, path). Explicitly NOT
    # an entity id (it was one until 0.2.121, which is the bug it caused).
    ("fs_record.py", "uuid5"),
    # scan_log / index_log row ids: JSONL diagnostic rows, never entities.
    ("schema_registry.py", "uuid4"),
    # record_error / claude_hook: log rows and a Phase-4 stub, not entities.
    ("record_error.py", "uuid4"),
    ("claude_hook.py", "uuid4"),
}


def _raw_uuid_sites(root: Path) -> list[str]:
    """Raw ``uuid.uuid4()`` / ``uuid.uuid5()`` calls under ``root``.

    Entity ids are minted by ``mint_uuid`` so the v4/v5 version policy lives in
    one place (see CLAUDE.md, "Mint through one place"). A hand-rolled uuid also
    escapes every identity guard — which is how four separate copies of
    ``uuid5(DNS, "project:"+cwd)`` came to exist, one of them silently skipping
    canonicalization.
    """
    hits: list[str] = []
    for path, tree in _trees(root):
        for node in ast.walk(tree):
            if _calls_to(node, "uuid4", "uuid5") and (
                path.name,
                node.func.attr,
            ) not in _RAW_UUID_ALLOWLIST:
                hits.append(f"{path.name}:{node.lineno} uuid.{node.func.attr}()")
    return sorted(hits)


def test_no_raw_uuid_in_the_identity_tree() -> None:
    sites = _raw_uuid_sites(FLOW_SDK / "fs_store")
    sites += _raw_uuid_sites(FLOW_SDK / "schema" / "type_info")
    assert sites == [], (
        "construct ids through `mint_uuid` (or, for a filesystem asset, "
        "`TypeInfo.mint_entity_id`) so the v4/v5 policy stays in one place. Note "
        "the argument order differs — mint_uuid(key, namespace=...) vs "
        "uuid.uuid5(namespace, key) — so preserve the pair exactly or every id of "
        "that type moves. Found:\n  " + "\n  ".join(sites)
    )


@pytest.mark.parametrize(
    "source, detector",
    [
        ("rid = info.read_id(ref) or info.mint_entity_id(ref)\n", _carrier_or_mint_sites),
        ("def thing_id(ref):\n    return mint_uuid(str(ref))\n", _per_type_minters),
        ("import uuid\nx = uuid.uuid4()\n", _raw_uuid_sites),
    ],
    ids=["carrier_or_mint", "per_type_minter", "raw_uuid"],
)
def test_the_detectors_actually_detect(tmp_path: Path, source: str, detector) -> None:
    """A guard that cannot fail is not a guard — each detector sees its own shape."""
    (tmp_path / "probe.py").write_text(source, encoding="utf-8")
    assert len(detector(tmp_path)) == 1
