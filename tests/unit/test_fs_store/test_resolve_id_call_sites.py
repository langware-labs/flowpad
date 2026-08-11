"""No call site may resolve identity as ``extract_id(...) or mint_id(...)``.

That expression was open-coded in eight places. It means "use the id in the
file, otherwise invent one" — which forks the entity whenever a rewrite has
wiped the carrier. It was already fixed ONCE, at a single call site, by
threading ``proposed_id`` through ``discover_record_by_path``; the index walk
never got the memo and kept forking for another release.

A parameter only protects the callers who remember to pass it. This test
protects the ones who don't: identity resolution goes through
``TypeInfo.resolve_id`` or it doesn't happen.
"""
from __future__ import annotations

import ast
from pathlib import Path

FLOW_SDK = Path(__file__).resolve().parents[3] / "flow_sdk"


def _is_call_to(node: ast.AST, name: str) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == name
    )


def _sites_in(root: Path) -> list[str]:
    """Every ``<x>.extract_id(...) or <y>.mint_id(...)`` under ``root``."""
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
            if _is_call_to(node.values[0], "extract_id") and _is_call_to(node.values[1], "mint_id"):
                hits.append(f"{path}:{node.lineno}")
    return sorted(hits)


def test_no_extract_or_mint_pairs_remain() -> None:
    sites = _sites_in(FLOW_SDK)
    assert sites == [], (
        "identity must be resolved via TypeInfo.resolve_id (which consults the row that "
        "already owns the path) — `extract_id(...) or mint_id(...)` forks the entity when "
        "a rewrite has wiped the carrier. Found at:\n  " + "\n  ".join(sites)
    )


def test_the_detector_actually_detects(tmp_path: Path) -> None:
    """A guard that can't fail is not a guard — run the REAL detector."""
    (tmp_path / "probe.py").write_text(
        "rid = info.extract_id(ref) or info.mint_id(ref)\n", encoding="utf-8"
    )
    assert len(_sites_in(tmp_path)) == 1
