"""Grep guard: no model slug is hard-coded in flow_sdk.

An LLM endpoint declares the model each size runs (``LLMEndpoint.models``); code that names a model
quietly decides for the endpoint. This walks every ``flow_sdk/**/*.py`` string constant (via ``ast``,
so docstrings and comments are skipped) for a gateway slug (``anthropic/...``, ``z-ai/...``) or a bare
``claude-<size>-<n>`` id. A file that legitimately holds slugs goes on ``ALLOWED`` with its reason.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / "flow_sdk"

SLUG = re.compile(r"^(anthropic|openai|google|z-ai|moonshotai|meta-llama|deepseek|qwen|x-ai)/[a-z0-9.\-]+$")
#: A bare claude id as a whole literal (prose that mentions one, e.g. a Field description, is not a pin).
BARE_CLAUDE = re.compile(r"^claude-(haiku|sonnet|opus)-\d[a-z0-9.\-]*$")

#: Files that may still hold slugs, each with why. Globs relative to the repo root.
ALLOWED = {
    "flow_sdk/external_apis/llm/dialects.py": "API_KEY endpoint seed (default_models) -- pending removal",
    "flow_sdk/transcript_analyzer/pricing/*": "pricing tables are keyed by model id",
    "flow_sdk/fs_store/indexer/functions/_claude_session_stats.py": "session cost stats price by model id",
}


def _allowed(rel: str) -> bool:
    return any(Path(rel).match(pattern) or rel == pattern for pattern in ALLOWED)


def _docstring_nodes(tree: ast.AST) -> set[int]:
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                out.add(id(body[0].value))
    return out


def _hits() -> dict[str, list[tuple[int, str]]]:
    found: dict[str, list[tuple[int, str]]] = {}
    for path in sorted(SDK.rglob("*.py")):
        rel = path.relative_to(ROOT).as_posix()
        if _allowed(rel):
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (SyntaxError, UnicodeDecodeError):
            continue
        docs = _docstring_nodes(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs:
                if SLUG.match(node.value) or BARE_CLAUDE.match(node.value):
                    found.setdefault(rel, []).append((node.lineno, node.value))
    return found


#: Source still holding slugs outside ALLOWED when this guard was added (2026-10-29). This documents
#: the debt: once every one is fixed the strict xfail goes red -- drop the marker then.
KNOWN_OFFENDERS = [
    "flow_sdk/builtin/agent_config.py:20 (LLMConfig.model Literal)",
    "flow_sdk/builtin/agentic_process/cli_drivers/hub_endpoint_binding.py:658,660 (_TEST_MODELS)",
    "flow_sdk/config.py:836,837 (search_model, search_compression_model)",
    "flow_sdk/external_apis/llm/simple_llm/completion.py:168 (default model)",
]


def test_allowlisted_files_exist() -> None:
    for pattern in ALLOWED:
        assert list(ROOT.glob(pattern)), f"stale allowlist entry: {pattern}"


@pytest.mark.xfail(strict=True, reason="hard-coded slugs remain in: " + "; ".join(KNOWN_OFFENDERS))
def test_no_hardcoded_model_slugs_in_flow_sdk() -> None:
    hits = _hits()
    assert not hits, "hard-coded model slugs:\n" + "\n".join(
        f"  {rel}:{line} {value!r}" for rel, rows in hits.items() for line, value in rows
    )
