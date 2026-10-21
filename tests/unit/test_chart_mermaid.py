"""Corpus-driven tests for the Excalidraw → Mermaid serializer.

The corpus under ``tests/fixtures/mermaid_corpus/`` is shared with the TS port
in ``ui/src/components/assets/editor/chart/excalidrawToMermaid.ts`` and
its vitest counterpart at ``ui/tests/react/unit/excalidrawToMermaid.test.ts``.
Both implementations must emit byte-identical output for each case.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.assets.types.chart_mermaid import excalidraw_to_mermaid

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


# ---------------------------------------------------------------- sequence


def test_sequence_to_mermaid_renders_participants_messages_and_subflows() -> None:
    from flow_sdk.assets.types.chart_mermaid import sequence_to_mermaid

    data = {
        "participants": [{"id": "user", "label": "User\nbrowser"}, {"id": "api", "label": "API"}],
        "messages": [
            {"id": "m1", "from": "user", "to": "api", "label": "POST /login"},
            {"id": "m2", "from": "api", "to": "api", "label": "hash password"},
            {"id": "m3", "from": "api", "to": "user", "label": "200 OK", "style": "dashed"},
            {"id": "m4", "from": "user", "to": "api", "label": "checkout", "ref": "payment-flow", "returns": "receipt"},
        ],
    }
    assert sequence_to_mermaid(data) == (
        "sequenceDiagram\n"
        "  participant user as User<br/>browser\n"
        "  participant api as API\n"
        "  user->>api: POST /login\n"
        "  api->>api: hash password\n"
        "  api-->>user: 200 OK\n"
        "  Note over user,api: ↗ checkout (chart payment-flow)\n"
        "  api-->>user: receipt\n"
    )


@pytest.mark.parametrize("data", [None, [], {}, {"participants": [], "messages": []}])
def test_sequence_to_mermaid_empty_never_raises(data) -> None:
    from flow_sdk.assets.types.chart_mermaid import sequence_to_mermaid

    assert sequence_to_mermaid(data) == "sequenceDiagram\n  %% empty chart\n"


def _sequence_chart(tmp_path: Path, fmt: str = "sequence") -> Path:
    folder = tmp_path / "agentic-assets" / "chart" / "login"
    folder.mkdir(parents=True)
    (folder / "CHART.md").write_text(f"---\nname: login\nformat: {fmt}\n---\n\nProse.\n", encoding="utf-8")
    (folder / "chart.json").write_text(
        json.dumps({"participants": [{"id": "a", "label": "A"}], "messages": [{"id": "1", "from": "a", "to": "a", "label": "go"}]}),
        encoding="utf-8",
    )
    return folder


def test_sync_chart_mermaid_writes_block_once(tmp_path: Path) -> None:
    from flow_sdk.assets.types.chart_mermaid import sync_chart_mermaid

    folder = _sequence_chart(tmp_path)
    assert sync_chart_mermaid(folder) is True
    text = (folder / "CHART.md").read_text(encoding="utf-8")
    assert text.startswith("---\nname: login\nformat: sequence\n---\n\nProse.\n")
    assert "<!-- BEGIN chart:auto -->\n```mermaid\nsequenceDiagram\n  participant a as A\n  a->>a: go\n```\n" in text
    assert sync_chart_mermaid(folder) is False  # unchanged → no write

    (folder / "chart.json").write_text(json.dumps({"participants": [{"id": "b", "label": "B"}], "messages": []}))
    assert sync_chart_mermaid(folder) is True
    text = (folder / "CHART.md").read_text(encoding="utf-8")
    assert text.count("<!-- BEGIN chart:auto -->") == 1 and "participant b as B" in text


@pytest.mark.parametrize("fmt", ["excalidraw", "mermaid"])
def test_sync_chart_mermaid_leaves_other_formats_alone(tmp_path: Path, fmt: str) -> None:
    from flow_sdk.assets.types.chart_mermaid import sync_chart_mermaid

    folder = _sequence_chart(tmp_path, fmt)
    before = (folder / "CHART.md").read_bytes()
    assert sync_chart_mermaid(folder) is False
    assert (folder / "CHART.md").read_bytes() == before


def test_sequence_to_mermaid_puts_a_sublabel_under_the_label() -> None:
    from flow_sdk.assets.types.chart_mermaid import sequence_to_mermaid

    out = sequence_to_mermaid({"participants": [{"id": "hue", "label": "Philips Hue", "sublabel": "api.meethue.com", "icon": "brands.philips-hue"}], "messages": []})
    assert "participant hue as Philips Hue<br/>api.meethue.com" in out
