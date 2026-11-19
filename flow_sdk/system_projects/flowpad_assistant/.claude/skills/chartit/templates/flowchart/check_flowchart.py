"""Check a flowchart chart folder before it is shown.

Usage: python3 -I check_flowchart.py <chart folder> [<chart folder> ...]

Checks each folder's flowchart.json against chartit.flowchart: unique ids, known kinds, exactly one
start, every edge joining two nodes that exist, every node reachable from the start, every question
with a `state` and at least two labelled exits, every `ref` naming a chart in the same project, and no
unknown fields (the editor owns the look). Warns on a label past 48 characters, past 6 questions or 14
nodes, and past 6 chart-level notes. Prints one JSON line per folder and exits 1 when any folder has
an error. Standard library only.
"""

import json
import re
import sys
from pathlib import Path

# Mirrors the chartit.flowchart* data_schema kinds (schema/…/data_schema/chartit/) — keep them in step.
KINDS = {"start", "question", "outcome", "step"}
FIELDS = {
    "chart": {"title", "nodes", "edges", "notes"},
    "node": {"id", "kind", "label", "state", "note", "ref"},
    "edge": {"from", "to", "label"},
}
MAX_LABEL, MAX_QUESTIONS, MAX_NODES, MAX_NOTES = 48, 6, 14, 6


def project_root(folder: Path) -> Path:
    for p in [folder, *folder.parents]:
        if (p / "agentic-assets").is_dir() and p != folder:
            return p
    return folder.parent


def chart_names(root: Path) -> set[str]:
    """Every chart's name in the project — `agentic-assets/chart/<name>/` and `docs/<area>/<name>/`:
    CHART.md frontmatter `name`, else the folder name."""
    names = set()
    docs = [*(root / "agentic-assets" / "chart").glob("*/CHART.md"), *(root / "docs").glob("*/*/CHART.md")]
    for doc in docs:
        m = re.search(r"^name:\s*(.+)$", doc.read_text(encoding="utf-8", errors="replace"), re.M)
        names.add(m.group(1).strip().strip("'\"") if m else doc.parent.name)
    return names


def _extra(kind: str, obj: dict, where: str, errors: list[str]) -> None:
    for key in sorted(set(obj) - FIELDS[kind]):
        errors.append(f"{where}: unknown field '{key}' (the editor owns the look)")


def check(folder: Path) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    try:
        data = json.loads((folder / "flowchart.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return {"chart": str(folder), "ok": False, "errors": [f"flowchart.json: {e}"], "warnings": []}
    if not isinstance(data, dict):
        return {"chart": str(folder), "ok": False, "errors": ["flowchart.json: not an object"], "warnings": []}
    _extra("chart", data, "chart", errors)

    nodes: dict[str, dict] = {}
    for i, node in enumerate(data.get("nodes") or []):
        where = f"nodes[{i}]"
        _extra("node", node, where, errors)
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id:
            errors.append(f"{where}: missing id")
            continue
        if node_id in nodes:
            errors.append(f"{where}: duplicate id '{node_id}'")
            continue
        nodes[node_id] = node
        if node.get("kind") not in KINDS:
            errors.append(f"{where}: kind must be one of {sorted(KINDS)}")
        label = node.get("label")
        if not label:
            errors.append(f"{where}: missing label")
        elif len(label) > MAX_LABEL:
            warnings.append(f"{where}: label is {len(label)} characters — keep it short, move detail to `note`")
        if node.get("state") and node.get("kind") != "question":
            warnings.append(f"{where}: `state` is for a question; use `note` here")

    exits: dict[str, list[dict]] = {node_id: [] for node_id in nodes}
    for i, edge in enumerate(data.get("edges") or []):
        where = f"edges[{i}]"
        _extra("edge", edge, where, errors)
        ok = True
        for end in ("from", "to"):
            if edge.get(end) not in nodes:
                errors.append(f"{where}: {end} '{edge.get(end)}' is no node")
                ok = False
        if ok:
            exits[edge["from"]].append(edge)

    starts = [node_id for node_id, node in nodes.items() if node.get("kind") == "start"]
    if len(starts) != 1:
        errors.append(f"a flowchart has exactly one start node, found {len(starts)}")
    else:
        seen, todo = set(), [starts[0]]
        while todo:
            at = todo.pop()
            if at in seen:
                continue
            seen.add(at)
            todo.extend(edge["to"] for edge in exits[at])
        for node_id in nodes:
            if node_id not in seen:
                errors.append(f"node '{node_id}' cannot be reached from the start")

    questions = [node_id for node_id, node in nodes.items() if node.get("kind") == "question"]
    for node_id in questions:
        if not nodes[node_id].get("state"):
            errors.append(f"question '{node_id}': missing `state` — what stored fact answers it?")
        out = exits[node_id]
        if len(out) < 2:
            errors.append(f"question '{node_id}': needs at least two exits")
        if any(not edge.get("label") for edge in out):
            errors.append(f"question '{node_id}': every exit needs a label (the answer it stands for)")
    for node_id, node in nodes.items():
        if node.get("kind") == "outcome" and exits[node_id]:
            warnings.append(f"outcome '{node_id}' has an exit — an outcome ends the flow; make it a step")

    if len(questions) > MAX_QUESTIONS or len(nodes) > MAX_NODES:
        warnings.append(
            f"{len(questions)} questions, {len(nodes)} nodes — past {MAX_QUESTIONS} / {MAX_NODES}, split it: "
            "give an outcome a `ref` to the chart that continues"
        )
    notes = data.get("notes") or []
    if any(not isinstance(note, str) or not note for note in notes):
        errors.append("notes: every note is a non-empty string")
    if len(notes) > MAX_NOTES:
        warnings.append(f"{len(notes)} chart notes — past {MAX_NOTES} the chart is two charts")

    refs = [node["ref"] for node in nodes.values() if node.get("ref")]
    if refs:
        known = chart_names(project_root(folder))
        for ref in refs:
            if ref not in known:
                errors.append(f"ref '{ref}' names no chart in the project")
    return {"chart": str(folder), "ok": not errors, "errors": errors, "warnings": warnings}


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    bad = False
    for arg in argv:
        result = check(Path(arg).resolve())
        print(json.dumps(result))
        bad = bad or not result["ok"]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
