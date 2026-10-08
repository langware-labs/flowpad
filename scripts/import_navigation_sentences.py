#!/usr/bin/env python3
"""The 200 UX-surface navigation sentences as eval examples of the SmartNavigator dataset.

    .venv/bin/python scripts/import_navigation_sentences.py [--dataset <folder>] [--scoreboard <md>]

Source: ``docs/navigation/navigation-sentences.md``. Each sentence becomes one ``eval`` row:

* ``input``  -- the utterance and ``here``: Home by default; a session, an agent, an endpoint or a
  trigger when the sentence speaks of "this …" (its target names a placeholder);
* ``context.candidates`` -- for a sentence that opens one specific thing, that thing (a fixture with
  a fixed id) plus two unrelated matches, as search would offer them -- recorded, so the eval
  replays the same options anywhere;
* ``ground_truth`` -- the expected ``navigator.decision``: ``quick`` + the target (a screen, an
  entity, a file, a URL, the log, or an ``action`` for what starts something rather than opening it);
  the verb is left free;
* ``data`` -- ``suite: ux-surface``, its number and group, where it was typed from, and the score the
  browser stress eval gave it (``browser_score``, for aligning the two).

Rows already imported (same ``suite`` + ``n``) are not appended again, but get today's expected
answers and browser score; rows with no suite are tagged ``benchmark`` (the original 52).
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
DOC = REPO / "docs/navigation/navigation-sentences.md"
SCOREBOARD = REPO / "ui/tests/manual_regression/_results/navigation-scoreboard.md"
ROW = re.compile(r"^\| (\d+) \| (.+?) \| (.+?) \|$", re.M)
GROUP = re.compile(r"^### ([A-Z])\. (.+?) \(\d+\)$", re.M)

# ── fixtures: fixed ids, so every replay offers the same things ─────────────
PROJECT = {"typeid": "project-6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b", "title": "flowpad-oss",
           "path": "/Users/dana/Flowpad workspace/flowpad-oss"}
SESSION = {"typeid": "agentic_process-7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d", "title": "refactor session"}
AGENT = {"typeid": "agent-2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f", "title": "support bot"}
ENDPOINT = {"typeid": "llm_endpoint-3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a", "title": "team openrouter"}
TRIGGER = {"typeid": "trigger-4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b", "title": "nightly report"}
ENTITIES = {  # entity:<type> targets → the one thing the sentence names
    "agentic_process": SESSION,
    "project": {"typeid": "project-5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d", "title": "gtm-studio"},
    "skill": {"typeid": "skill-2408c41c-b3a4-42fe-8868-243b2ff11aae", "title": "agent-builder"},
    "task": {"typeid": "task-8b3c4d5e-6f7a-4b2c-8d3e-4f5a6b7c8d9e", "title": "Zoom OAuth on dev"},
    "claude_md": {"typeid": "claude_md-9c4d5e6f-7a8b-4c3d-9e4f-5a6b7c8d9e0f", "title": "CLAUDE.md"},
    "dataset": {"typeid": "dataset-bdd6988b-7d58-42c6-a483-bdfbbc4bc304", "title": "SmartNavigator"},
    "credential": {"typeid": "credential-1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", "title": "google"},
    "data_source": {"typeid": "data_source-0d5e6f7a-8b9c-4d4e-8f5a-6b7c8d9e0f1a", "title": "gmail-work"},
    "trigger": TRIGGER,
    "conversation": {"typeid": "conversation-1e6f7a8b-9c0d-4e5f-9a6b-7c8d9e0f1a2b", "title": "Dana"},
}
ASSISTANT_PROJECT = {"typeid": "project-c82a1115-2f20-52e0-aa2a-4658898b5873", "title": "Flowpad Assistant"}
DISTRACTORS = [
    {"typeid": "skill-5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", "type": "skill", "title": "flowpad-assistance"},
    {"typeid": "markdown-6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c", "type": "markdown", "title": "Create new"},
]
def uid(thing: dict) -> str:
    """A fixture's bare id (``project-<uuid>`` → ``<uuid>``)."""
    return thing["typeid"].split("-", 1)[1]


#: Concrete values for the placeholders a target names (``<id>`` is the row's own context).
FILLS = {"<ref>": uid(SESSION), "<checkpoint>": "c0ffee12", "<project>": uid(PROJECT), "<room>": "room-main",
         "<status>": "open"}


def rows() -> list[dict]:
    """``{group, n, sentence, target}`` for every row of the doc, in order (the one parser of it)."""
    text = DOC.read_text()
    marks = [(m.start(), f"{m.group(1)}. {m.group(2)}") for m in GROUP.finditer(text)]
    out = []
    for m in ROW.finditer(text):
        out.append({
            "group": [g for pos, g in marks if pos < m.start()][-1],
            "n": int(m.group(1)),
            "sentence": re.sub(r"\s*\(typo\)$", "", m.group(2).strip()),
            "target": m.group(3).strip(),
        })
    return out


def slug(action: str) -> str:
    return re.sub(r"[^a-z0-9:]+", "-", action.lower().replace("›", ":")).strip("-")


def here_for(target: str) -> tuple[str, dict]:
    """(from, here): where the sentence is typed. Home, unless it speaks of "this …"."""
    base = {"project": PROJECT}
    if "agentic_process" in target or "lens/claude/transcript" in target or "/diff/" in target or "live_session" in target:
        return "session", {**base, "view": "agentic_process", "pointer": uid(SESSION),
                           "address": f"/dock/agentic_process/{uid(SESSION)}",
                           "process": SESSION, "entity": SESSION}
    if "/agent/<id>" in target:
        return "agent", {**base, "view": "agent", "pointer": f"{uid(AGENT)}/stream_inbox",
                         "address": f"/dock/agent/{uid(AGENT)}/stream_inbox", "entity": AGENT}
    if "llm-endpoints/<id>" in target:
        return "endpoint", {**base, "view": "llm-endpoints", "page": "hub", "pointer": uid(ENDPOINT),
                            "address": f"/dock/hub/llm-endpoints/{uid(ENDPOINT)}", "entity": ENDPOINT}
    if "trigger/log" in target:
        return "automation", {**base, "view": "automations", "address": f"/dock/automations?trigger={uid(TRIGGER)}"}
    return "home", {**base, "view": "home", "page": "desk", "address": "/dock/home"}


def _named_entity(target: str) -> dict:
    """The fixture an ``entity:<type>`` target names."""
    if "@flowpad_assistant" in target:
        return ASSISTANT_PROJECT
    return ENTITIES[target[len("entity:"):].split(" ")[0]]


def gold(target: str, from_: str) -> dict:
    """The expected ``navigator.decision`` for a doc target."""
    if target.startswith("ACTION:"):
        return {"route": "quick", "target": {"kind": "action", "value": slug(target[len("ACTION:"):].strip())}}
    for kind in ("file", "url", "log"):
        if target.startswith(f"{kind}:"):
            value = target[len(kind) + 1:].split(" (")[0].strip()
            return {"route": "quick", "target": {"kind": kind, "value": value}}
    if target.startswith("entity:"):
        return {"route": "quick", "target": {"kind": "entity", "value": _named_entity(target)["typeid"]}}
    path = target.split(" (")[0].strip()
    if not path.startswith("/dock/"):
        return {"route": "quick", "target": {"kind": "url", "value": path}}  # /win/assistant, /discover
    value = path[len("/dock/"):]
    fills = {**FILLS, "<id>": uid({"session": SESSION, "agent": AGENT, "endpoint": ENDPOINT}.get(from_, PROJECT))}
    for hole, fill in fills.items():
        value = value.replace(hole, fill)
    value = value.replace("/…", "").replace("…", "")
    return {"route": "quick", "target": {"kind": "view", "value": value}}




def golds_for(target: str, from_: str) -> list[dict]:
    """Every right answer: the target, plus a project's entity for its screen. (A screen and its
    default tab need no second gold: the eval judges them one place -- ``navigation.same_place``.)"""
    first = gold(target, from_)
    t = first["target"]
    alt = []
    if t["kind"] == "view" and t["value"].startswith("project/") and t["value"].count("/") == 1:
        alt.append({"route": "quick", "target": {"kind": "entity", "value": f"project-{t['value'].split('/', 1)[1]}"}})
    return [first, *alt]


def _one_or_many(answers: list[dict]) -> dict | list[dict]:
    """A row stores one gold as a value and several (any one right) as a list."""
    return answers if len(answers) > 1 else answers[0]


def candidates(target: str) -> list[dict]:
    if not target.startswith("entity:"):
        return []
    thing = _named_entity(target)
    return [{"typeid": thing["typeid"], "type": thing["typeid"].split("-", 1)[0], "title": thing["title"]}, *DISTRACTORS]


def browser_scores(path: Path) -> dict[int, int]:
    """``{n: 1|2|3}`` from the browser scoreboard's table (cells, so column padding never matters)."""
    if not path.exists():
        return {}
    out = {}
    for line in path.read_text().splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) > 3 and cells[0].isdigit() and cells[3] in ("1", "2", "3"):
            out[int(cells[0])] = int(cells[3])
    return out


def build(scores: dict[int, int]) -> list[dict]:
    out = []
    for r in rows():
        from_, here = here_for(r["target"])
        out.append({
            "kind": "eval",
            "input": {"utterance": r["sentence"], "here": here},
            "context": {"candidates": candidates(r["target"])},
            "ground_truth": _one_or_many(golds_for(r["target"], from_)),
            "data": {"suite": "ux-surface", "case": f"ux-{r['n']}", "n": r["n"], "group": r["group"],
                     "from": from_, "target": r["target"], "browser_score": scores.get(r["n"])},
        })
    return out


async def main(folder: Path, scoreboard: Path) -> None:
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.datasets.score import golds
    from flow_sdk.schema.data_spec import declared

    declared.ensure_shipped()
    ds = Dataset.at(folder)
    built = {r["data"]["n"]: r for r in build(browser_scores(scoreboard))}
    tagged = refreshed = scored = 0
    have: set[int] = set()
    for row in ds.read_rows():
        data = dict(row.data or {})
        if not data.get("suite"):  # the original rows are the benchmark
            ds.set_data(row.id, {**data, "suite": "benchmark"})
            tagged += 1
            continue
        if data.get("suite") != "ux-surface" or data.get("n") not in built:
            continue
        have.add(data["n"])
        want = built[data["n"]]
        if data.get("browser_score") != want["data"]["browser_score"]:  # carry the latest browser score
            ds.set_data(row.id, {**data, "browser_score": want["data"]["browser_score"]})
            scored += 1
        current = [g.model_dump(mode="json", exclude_none=True) for g in golds(row)]
        wanted = want["ground_truth"] if isinstance(want["ground_truth"], list) else [want["ground_truth"]]
        if current != wanted:  # today's expected answers (``annotate`` replaces a row's gold)
            await ds.annotate(row.id, want["ground_truth"])
            refreshed += 1
    new = [r for n, r in built.items() if n not in have]
    ids = await ds.append(new) if new else []
    print(  # noqa: T201 -- a script reports
        f"tagged {tagged} benchmark rows; appended {len(ids)} ux-surface rows ({len(have)} already there); "
        f"refreshed {refreshed} golds; browser scores on {scored} rows"
    )
    problems = Dataset.at(folder).validate_rows()
    if problems:
        raise SystemExit(f"rows that do not read back: {problems[:5]}")


if __name__ == "__main__":
    from flow_sdk.core.navigation import DATASET

    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=DATASET)
    ap.add_argument("--scoreboard", type=Path, default=SCOREBOARD)
    a = ap.parse_args()
    asyncio.run(main(a.dataset, a.scoreboard))
