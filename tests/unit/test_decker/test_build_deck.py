"""Unit tests for the decker template's ``build_deck.py`` assembler.

``build_deck.py`` turns a ``deck.json`` into ONE self-contained HTML file
(inlined tokens/theme/Reveal + base64 media). These tests drive it as a
subprocess against the REAL shipped template (its six exemplar layouts), so slot
filling, repeatable-item stamping, optional-slot removal, and self-containment
are exercised end-to-end and deterministically.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

# do not increase timeout without approval — subprocess assembly is <1s.
pytestmark = pytest.mark.timeout(5)

_SKILL = (
    Path(__file__).resolve().parents[3]  # tests/unit/test_decker/ → repo root
    / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/decker"
)
TEMPLATE_DIR = _SKILL / "template"
BUILD_DECK = TEMPLATE_DIR / "tools" / "build_deck.py"


def _build(tmp_path: Path, deck: dict) -> subprocess.CompletedProcess:
    """Run build_deck.py on a deck dict; template resolves to the real scaffold."""
    deck = {**deck, "template": str(TEMPLATE_DIR)}
    deck_json = tmp_path / "deck.json"
    deck_json.write_text(json.dumps(deck), encoding="utf-8")
    out = tmp_path / "out.html"
    proc = subprocess.run(
        [sys.executable, str(BUILD_DECK), str(deck_json), "-o", str(out)],
        capture_output=True,
        text=True,
    )
    proc.out_path = out  # type: ignore[attr-defined]
    return proc


def _html(proc: subprocess.CompletedProcess) -> str:
    assert proc.returncode == 0, f"build failed: {proc.stderr}"
    return proc.out_path.read_text(encoding="utf-8")  # type: ignore[attr-defined]


# ── self-containment (the sandbox contract) ────────────────────────────────────

def test_self_contained_no_external_refs(tmp_path: Path) -> None:
    html = _html(_build(tmp_path, {
        "title": "Smoke",
        "slides": [{"layout": "cover-centered", "slots": {"title": "Hello"}}],
    }))
    assert 'src="http' not in html
    assert 'href="http' not in html
    assert 'src="./' not in html
    assert "hash: false" in html or "hash:false" in html
    assert 'data-layout="cover-centered"' in html


def test_media_inlined_as_data_uri(tmp_path: Path) -> None:
    html = _html(_build(tmp_path, {
        "title": "M",
        "slides": [{"layout": "media-full-bleed",
                    "slots": {"media": "media/common/placeholder.png"}}],
    }))
    assert 'src="data:image/' in html
    assert 'src="media/' not in html  # the relative path was replaced


# ── slot behaviours ────────────────────────────────────────────────────────────

def test_slot_text_is_escaped(tmp_path: Path) -> None:
    html = _html(_build(tmp_path, {
        "title": "E",
        "slides": [{"layout": "cover-centered", "slots": {"title": "A & B <x>"}}],
    }))
    assert "A &amp; B &lt;x&gt;" in html
    assert "A & B <x>" not in html


def test_items_stamped_and_optional_removed(tmp_path: Path) -> None:
    html = _html(_build(tmp_path, {
        "title": "Metrics",
        "slides": [{"layout": "metrics-grid", "slots": {"title": "Traction", "items": [
            {"metric-value": "12k", "metric-label": "users", "metric-delta": "+40%"},
            {"metric-value": "$1.2M", "metric-label": "ARR"},  # no delta → optional removed
        ]}}],
    }))
    # exactly two items stamped — the static placeholder cards were replaced
    assert html.count('class="metric-value"') == 2
    assert "12k" in html and "$1.2M" in html
    # the <template data-item> stamp source must not leak into output
    assert "data-item" not in html
    # item 1's optional delta was filled; item 2 omitted it and the template's
    # placeholder default ("+0%") did NOT leak → data-optional/unfilled handled
    assert "+40%" in html
    assert "+0%" not in html


# ── error paths ────────────────────────────────────────────────────────────────

def test_unknown_layout_errors(tmp_path: Path) -> None:
    proc = _build(tmp_path, {"slides": [{"layout": "nope", "slots": {}}]})
    assert proc.returncode != 0
    assert "unknown layout" in proc.stderr.lower()


def test_unknown_slot_errors(tmp_path: Path) -> None:
    proc = _build(tmp_path, {"slides": [{"layout": "cover-centered", "slots": {"bogus": "x"}}]})
    assert proc.returncode != 0
    assert "unknown slot" in proc.stderr.lower()
