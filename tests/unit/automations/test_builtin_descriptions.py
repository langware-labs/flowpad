"""Every automation Flowpad ships says, in plain words, what it does for the person.

A person who opens Automations and finds "Claude transcript watcher" has to be
able to tell it is not spying on them: what it does for them, why Flowpad needs
it, and what it touches. Implementation detail belongs in a code comment.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.config import system_projects_root
from flow_sdk.graph_workflow_manager.service_graph_workflows import MINI_TRIGGER_DESCRIPTION
from flow_sdk.server.builtin_triggers import _service_trigger_specs

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

#: Words that mean the description is written for a developer, not the person.
JARGON = ("callback", "TranscriptStreamer", "@register", "dispatch", "jsonl", "JSONL", "fan out", "fans out",
          "fire_once", "rag.runtime", "app.tab.ready", "delta", "toplog", "broadcast", "flow llm")


def _shipped_trigger_docs() -> list[tuple[str, str]]:
    root = Path(system_projects_root())
    out = []
    for path in sorted(root.rglob("agentic-assets/trigger/*/trigger.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        out.append((doc.get("name") or path.parent.name, doc.get("description") or ""))
    return out


def _all() -> list[tuple[str, str]]:
    seeds = [(s["name"], s.get("description") or "") for s in _service_trigger_specs()]
    return seeds + _shipped_trigger_docs() + [("Mini analyzer (manual)", MINI_TRIGGER_DESCRIPTION)]


def test_there_are_builtins_to_check():
    names = [name for name, _ in _all()]
    assert {"Claude transcript watcher", "System heartbeat", "Mini analyzer (manual)"} <= set(names)
    assert any("LLM setup" in n for n in names)


@pytest.mark.parametrize("name,description", _all(), ids=lambda v: v if isinstance(v, str) and len(v) < 60 else "")
def test_each_builtin_explains_itself_in_plain_words(name, description):
    assert len(description) >= 60, f"{name}: say what it does for the person and why Flowpad needs it"
    leaked = [word for word in JARGON if word in description]
    assert not leaked, f"{name}: developer words in a person-facing description: {leaked}"
