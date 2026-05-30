"""Corpus-driven tests for the Excalidraw → Mermaid serializer.

The corpus under ``tests/fixtures/mermaid_corpus/`` is shared with the TS port
in ``ui/src/components/assets/editor/whiteboard/excalidrawToMermaid.ts`` and
its vitest counterpart at ``ui/tests/react/unit/excalidrawToMermaid.test.ts``.
Both implementations must emit byte-identical output for each case.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.fs_store.indexer.functions._whiteboard_mermaid import excalidraw_to_mermaid


CORPUS_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "mermaid_corpus"


def _corpus_cases() -> list[str]:
    cases: list[str] = []
    for f in sorted(CORPUS_DIR.glob("*.excalidraw.json")):
        stem = f.name.removesuffix(".excalidraw.json")
        if (CORPUS_DIR / f"{stem}.mermaid").is_file():
            cases.append(stem)
    return cases


@pytest.mark.parametrize("case", _corpus_cases())
def test_corpus_case_produces_expected_mermaid(case: str) -> None:
    json_path = CORPUS_DIR / f"{case}.excalidraw.json"
    mermaid_path = CORPUS_DIR / f"{case}.mermaid"

    with json_path.open("r", encoding="utf-8") as fp:
        data = json.load(fp)
    expected = mermaid_path.read_text(encoding="utf-8")

    actual = excalidraw_to_mermaid(data)

    assert actual == expected, (
        f"Mismatch for {case}:\n"
        f"--- expected ({len(expected)} bytes) ---\n{expected}\n"
        f"--- actual   ({len(actual)} bytes) ---\n{actual}\n"
    )


def test_empty_input_returns_empty_board() -> None:
    assert excalidraw_to_mermaid({}) == "flowchart TD\n  %% empty board\n"
    assert excalidraw_to_mermaid({"elements": []}) == "flowchart TD\n  %% empty board\n"


def test_non_dict_input_returns_empty_board() -> None:
    assert excalidraw_to_mermaid(None) == "flowchart TD\n  %% empty board\n"  # type: ignore[arg-type]
    assert excalidraw_to_mermaid("nope") == "flowchart TD\n  %% empty board\n"  # type: ignore[arg-type]


def test_deleted_elements_are_skipped() -> None:
    data = {
        "elements": [
            {"id": "r1", "type": "rectangle", "x": 0, "y": 0, "width": 80, "height": 40, "isDeleted": True},
            {"id": "r2", "type": "rectangle", "x": 200, "y": 0, "width": 80, "height": 40},
        ],
    }
    out = excalidraw_to_mermaid(data)
    assert "N1[Untitled]" in out
    assert "N2" not in out


def test_label_escaping_for_special_chars() -> None:
    data = {
        "elements": [
            {"id": "r1", "type": "rectangle", "x": 0, "y": 0, "width": 200, "height": 40},
            {"id": "t1", "type": "text", "x": 10, "y": 10, "width": 100, "height": 20, "text": "a[b]c"},
        ],
    }
    out = excalidraw_to_mermaid(data)
    assert 'N1["a[b]c"]' in out


def test_malformed_input_emits_comment_not_raise() -> None:
    # Deliberately broken — elements is a non-list, non-None type.
    out = excalidraw_to_mermaid({"elements": 42})
    assert out == "flowchart TD\n  %% empty board\n"
