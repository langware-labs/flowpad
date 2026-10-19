"""Every automation Flowpad ships says, simply and calmly, what it does for the person.

A person who opens Automations and finds "Claude Code chats" should read
what they get from it, in a sentence or two — not machinery, and not words that
sound like surveillance. Implementation detail belongs in a code comment.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.config import system_projects_root
from flow_sdk.graph_workflow_manager.service_graph_workflows import MINI_TRIGGER_SPEC
from flow_sdk.server.builtin_triggers import _service_trigger_specs

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

#: Words that mean the description is written for a developer, not the person.
JARGON = ("callback", "TranscriptStreamer", "@register", "dispatch", "jsonl", "JSONL", "fan out", "fans out",
          "fire_once", "rag.runtime", "app.tab.ready", "delta", "toplog", "broadcast", "flow llm")
#: Words that make a helper sound like it is watching the person.
SCARY = ("watch", "monitor", "track", "scan", "spy", "collect", "reads your", "reading")
#: Words that name the machinery rather than what it does for the person.
MACHINERY = ("watcher", "heartbeat", "toplog", "(")
#: Long enough to say something, short enough to read at a glance.
MIN_CHARS, MAX_CHARS = 30, 140


def _shipped_trigger_docs() -> list[tuple[str, str]]:
    root = Path(system_projects_root())
    out = []
    for path in sorted(root.rglob("agentic-assets/trigger/*/trigger.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        out.append((doc.get("name") or path.parent.name, doc.get("description") or ""))
    return out


def _all() -> list[tuple[str, str]]:
    seeds = [(s["name"], s.get("description") or "") for s in _service_trigger_specs()]
    return seeds + _shipped_trigger_docs() + [(MINI_TRIGGER_SPEC["name"], MINI_TRIGGER_SPEC["description"])]


def test_there_are_builtins_to_check():
    names = [name for name, _ in _all()]
    assert {"Claude Code chats", "Background upkeep", "Daily self-check", "First-time setup"} <= set(names)


@pytest.mark.parametrize("name,description", _all(), ids=lambda v: v if isinstance(v, str) and len(v) < 60 else "")
def test_each_builtin_explains_itself_in_plain_words(name, description):
    assert not any(word in name.lower() for word in MACHINERY), f"{name}: a plain name, not machinery"
    assert MIN_CHARS <= len(description) <= MAX_CHARS, f"{name}: one or two short sentences saying what it does for you"
    leaked = [word for word in JARGON if word in description]
    assert not leaked, f"{name}: developer words in a person-facing description: {leaked}"
    scary = [word for word in SCARY if word in description.lower()]
    assert not scary, f"{name}: sounds like it is watching the person: {scary}"
