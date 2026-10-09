"""Routing integrity for the data-management skill (modelled on the connect-data-source one).

Every routing row points at a file that exists, every file is reachable from a row, and the
ground rules -- inlined in every mode file on purpose -- cannot drift apart silently. The two
that decide right from wrong answers are pinned by name: the probe gate and the silent ``Any``.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.timeout(5)

SKILL_DIR = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/data-management"
)
INDEX = SKILL_DIR / "SKILL.md"
IGNORED_DIRS = {".flow", "__pycache__"}


def _routed_paths(text: str) -> set[str]:
    return set(re.findall(r"(?:modes|references|scripts)/[A-Za-z0-9_.-]+", text))


def _authored_files() -> list[Path]:
    return [
        p for p in SKILL_DIR.rglob("*")
        if p.is_file() and p != INDEX and not any(part in IGNORED_DIRS for part in p.relative_to(SKILL_DIR).parts)
    ]


def test_the_skill_is_installed_where_it_ships_from():
    assert INDEX.is_file(), f"no SKILL.md at {SKILL_DIR}"


def test_every_routing_row_resolves():
    for ref in sorted(_routed_paths(INDEX.read_text(encoding="utf-8"))):
        assert (SKILL_DIR / ref).is_file(), f"SKILL.md routes to {ref}, which does not exist"


def test_no_unreachable_files():
    routed = _routed_paths(INDEX.read_text(encoding="utf-8"))
    for path in _authored_files():
        rel = str(path.relative_to(SKILL_DIR))
        assert rel in routed, f"{rel} is in the skill but no routing row mentions it"


def test_every_mode_file_inlines_the_ground_rules():
    for mode in sorted((SKILL_DIR / "modes").glob("*.md")):
        text = mode.read_text(encoding="utf-8")
        assert "Ground rules (inline by design)" in text, f"{mode.name} lost its ground rules"
        assert "Prove it in a probe first" in text, f"{mode.name} must gate on the probe"
        assert "silently `Any`" in text, f"{mode.name} must say an unknown kind is Any"
        assert "never widen" in text.lower(), mode.name


def test_scripts_run_on_the_workers_interpreter():
    # A bare `python3` may resolve to an interpreter without flow_sdk (the worker env contract).
    for path in [INDEX, *_authored_files()]:
        if path.suffix == ".md":
            text = path.read_text(encoding="utf-8")
            assert "python3 <" not in text and "python3 scripts" not in text, f"{path.name} runs a bare python3"


def test_the_skill_never_reaches_for_the_navigating_verb():
    forbidden = "flow " + "navigate"
    for path in [INDEX, *_authored_files()]:
        if path.suffix == ".md":
            assert forbidden not in path.read_text(encoding="utf-8"), f"{path.name} names the navigating verb"


def test_the_description_carries_the_triggering_burden():
    fm = yaml.safe_load(INDEX.read_text(encoding="utf-8").split("---")[1])
    description = fm["description"]
    assert fm["name"] == "data-management"
    for phrase in ("schema", "dataset", "rows", "probe", "migrate", "data_spec"):
        assert phrase in description.lower(), f"the description never mentions {phrase!r}"
    assert "NOT for" in description


def test_the_index_stays_an_index():
    assert len(INDEX.read_text(encoding="utf-8").splitlines()) < 300


def test_dm_ctl_shields_namespaced_kinds_from_argparse(monkeypatch, capsys):
    """``--acme--.crm.lead`` starts with ``--``: argparse read it as an option and every
    ``kind`` / ``check`` call on a project kind died with a usage error (found on a live probe)."""
    import importlib.util
    import json

    spec = importlib.util.spec_from_file_location("dm_ctl", SKILL_DIR / "scripts/dm_ctl.py")
    dm_ctl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dm_ctl)
    seen = {}
    monkeypatch.setitem(dm_ctl.VERBS, "check", (lambda args: seen.update(vars(args)) or {}, dm_ctl.VERBS["check"][1]))
    assert dm_ctl.main(["check", "--acme--.crm.lead", '{"name": "x"}']) == 0
    assert seen["kind"] == "--acme--.crm.lead" and seen["value"] == '{"name": "x"}'
    assert json.loads(capsys.readouterr().out) == {"ok": True}
