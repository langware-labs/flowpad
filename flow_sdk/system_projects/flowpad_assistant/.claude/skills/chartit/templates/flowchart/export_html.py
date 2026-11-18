"""Write a flowchart chart as ONE self-contained HTML file — the copy that opens anywhere.

Usage: python3 -I export_html.py <chart folder> [--out <file.html>]

Reads the folder's flowchart.json (and CHART.md for the name and description) and writes
`<chart folder>/<folder name>.html`: the flow, the State and Notes panels, hover, zoom and a Table
view, in light and dark. The positions are worked out here and written into the file, so it holds no
layout library and loads nothing from the network. Prints one JSON line. Standard library only.

The look mirrors Flowpad's chart editor (ui/src/components/assets/editor/chart: chartTheme.ts,
FlowchartChartView.tsx) — keep the tokens and styles below in step with it. The layout is this
script's own top-down tree, not the editor's, so positions can differ from what the editor draws.
"""

import argparse
import html
import json
import re
import sys
from pathlib import Path

NODE = {"w": 240, "chars": 25, "pad": 16}
QUESTION = {"w": 290, "chars": 20, "pad": 44}
LINE, GAP_X, GAP_Y, MARGIN, LABEL_CHAR_W, CHANNEL = 21, 40, 72, 32, 7.2, 22
PLATE_H = 22  # an exit's label plate
# Where a route turns inside the gap under its row — one lane per kind of exit, so they never share a
# line: a way back up or a long jump, a tree branch, a second way into the next row.
LANE_FAR, LANE_TREE, LANE_CROSS = 9, 18, 34
LABEL_ABOVE, LABEL_BELOW, ENTER_ABOVE = 30, 16, 16  # a label over its target / under its source; a far route's last turn
CHANNEL_PAD = (40, 56)  # extra width and height when a route runs in the side channel
SOURCE = "flowchart.json"
KIND_NAME = {"start": "Start", "question": "Question", "outcome": "Outcome", "step": "Step"}

LIGHT = {
    "--surface-0": "#f4f3f0", "--surface-1": "#fcfcfb", "--surface-2": "#f0efec",
    "--text-primary": "#0b0b0b", "--text-secondary": "#52514e", "--text-muted": "#8a8984",
    "--hairline": "#e3e2de", "--hairline-strong": "#c9c8c2", "--s1": "#2a78d6", "--focus": "#2a78d6",
    "--side-fact": "#2a78d6", "--side-note": "#eb6834",
}  # fmt: skip
DARK = {
    "--surface-0": "#121211", "--surface-1": "#1a1a19", "--surface-2": "#252523",
    "--text-primary": "#f0efec", "--text-secondary": "#c3c2b7", "--text-muted": "#8f8e88",
    "--hairline": "#2e2e2b", "--hairline-strong": "#44443f", "--s1": "#3987e5", "--focus": "#3987e5",
    "--side-fact": "#3987e5", "--side-note": "#d95926",
}  # fmt: skip


def wrap(text: str, chars: int, lines: int = 3) -> list[str]:
    """Word-wrap to at most `lines` lines of `chars` characters; a cut last line ends in "…"."""
    out: list[str] = []
    cur = ""
    for word in text.split():
        nxt = f"{cur} {word}" if cur else word
        if len(nxt) <= chars:
            cur = nxt
            continue
        if cur:
            out.append(cur)
        cur = word if len(word) <= chars else word[: chars - 1] + "…"
    if cur:
        out.append(cur)
    if len(out) > lines:
        out = out[:lines]
        out[-1] = out[-1][: chars - 1] + "…"
    return out


def text(v: object) -> str:
    return v.strip() if isinstance(v, str) else ""


def esc(v: object) -> str:
    return html.escape(str(v), quote=True)


def sign(v: float) -> int:
    return (v > 0) - (v < 0)


def read(folder: Path) -> dict:
    """The chart as plain data; a malformed entry is dropped, like the editor does."""
    data = json.loads((folder / SOURCE).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("not an object")
    nodes, seen = [], set()
    for item in data.get("nodes") or []:
        node_id = text(item.get("id")) if isinstance(item, dict) else ""
        if not node_id or node_id in seen:
            continue
        seen.add(node_id)
        kind = item.get("kind") if item.get("kind") in KIND_NAME else "step"
        nodes.append(
            {"id": node_id, "kind": kind, "label": text(item.get("label")) or node_id,
             "state": text(item.get("state")), "note": text(item.get("note"))}
        )  # fmt: skip
    edges = [
        {"from": e["from"], "to": e["to"], "label": text(e.get("label"))}
        for e in data.get("edges") or []
        if isinstance(e, dict) and e.get("from") in seen and e.get("to") in seen and e["from"] != e["to"]
    ]
    doc = folder / "CHART.md"
    md = doc.read_text(encoding="utf-8", errors="replace") if doc.is_file() else ""

    def front(key: str) -> str:
        m = re.search(rf"^{key}:\s*(.+)$", md, re.M)
        return m.group(1).strip().strip("'\"") if m else ""

    return {
        "title": text(data.get("title")) or front("name") or folder.name,
        "description": front("description"),
        "nodes": nodes,
        "edges": edges,
        "notes": [n for n in map(text, data.get("notes") or []) if n],
    }


def layout(value: dict) -> dict:
    """A top-down tree: a node sits one row under its deepest parent, centred over its children.
    An exit that is not a tree branch (a second way in, a way back up) runs in a channel on the right."""
    nodes = {n["id"]: n for n in value["nodes"]}
    edges = value["edges"]
    exits: dict[str, list[int]] = {i: [] for i in nodes}
    for k, e in enumerate(edges):
        exits[e["from"]].append(k)

    back: set[int] = set()
    mark: dict[str, int] = {}

    def visit(i: str) -> None:
        mark[i] = 1
        for k in exits[i]:
            to = edges[k]["to"]
            if mark.get(to) == 1:
                back.add(k)
            elif to not in mark:
                visit(to)
        mark[i] = 2

    start = next((i for i, n in nodes.items() if n["kind"] == "start"), next(iter(nodes), None))
    for i in [start, *nodes] if start else []:
        if i not in mark:
            visit(i)

    row = {i: 0 for i in nodes}
    for _ in nodes:
        for k, e in enumerate(edges):
            if k not in back:
                row[e["to"]] = max(row[e["to"]], row[e["from"]] + 1)

    parent: dict[str, int] = {}
    for k, e in enumerate(edges):
        if k not in back and e["to"] not in parent and row[e["from"]] == row[e["to"]] - 1:
            parent[e["to"]] = k
    tree = set(parent.values())
    kids = {i: [edges[k]["to"] for k in exits[i] if k in tree] for i in nodes}

    boxes: dict[str, dict] = {}
    number = 0
    for i, n in nodes.items():
        dim = QUESTION if n["kind"] == "question" else NODE
        lines = wrap(n["label"], dim["chars"])
        if n["kind"] == "question":
            number += 1
        boxes[i] = {
            "node": n, "n": str(number) if n["kind"] == "question" else "", "lines": lines,
            "w": dim["w"], "h": len(lines) * LINE + dim["pad"] * 2,
        }  # fmt: skip

    span: dict[str, float] = {}  # a node's subtree width
    below: dict[str, float] = {}  # its children's widths, side by side

    def measure(i: str) -> float:
        below[i] = sum(measure(c) for c in kids[i]) + GAP_X * max(0, len(kids[i]) - 1)
        span[i] = max(boxes[i]["w"], below[i])
        return span[i]

    def place(i: str, left: float) -> None:
        boxes[i]["x"] = left + span[i] / 2 - boxes[i]["w"] / 2
        at = left + (span[i] - below[i]) / 2
        for c in kids[i]:
            place(c, at)
            at += span[c] + GAP_X

    left = float(MARGIN)
    for i in nodes:
        if i not in parent:
            measure(i)
            place(i, left)
            left += span[i] + GAP_X
    right = left - GAP_X

    rows = max(row.values(), default=0) + 1
    row_h = [max((b["h"] for i, b in boxes.items() if row[i] == r), default=0) for r in range(rows)]
    row_top = [MARGIN + sum(row_h[:r]) + GAP_Y * r for r in range(rows)]
    for i, b in boxes.items():
        b["y"] = row_top[row[i]] + (row_h[row[i]] - b["h"]) / 2
    row_bottom = [row_top[r] + row_h[r] for r in range(rows)]

    lines = []
    channels = 0
    for k, e in enumerate(edges):
        s, t = boxes[e["from"]], boxes[e["to"]]
        sx, sy, tx = s["x"] + s["w"] / 2, s["y"] + s["h"] / 2, t["x"] + t["w"] / 2
        dx, half, diamond = tx - sx, s["w"] / 2, s["node"]["kind"] == "question"
        gap = row_bottom[row[e["from"]]]
        if k in tree:
            if diamond and abs(dx) <= half:
                # Straight down from the diamond's lower edge, right above the child.
                pts = [(tx, sy + s["h"] / 2 * (1 - abs(dx) / half)), (tx, t["y"])]
            elif diamond:
                pts = [(sx + (half if dx > 0 else -half), sy), (tx, sy), (tx, t["y"])]
            else:
                pts = [(sx, s["y"] + s["h"]), (sx, gap + LANE_TREE), (tx, gap + LANE_TREE), (tx, t["y"])]
            label_at = (tx, t["y"] - LABEL_ABOVE)
        elif k not in back and row[e["to"]] == row[e["from"]] + 1:
            pts = [(sx, s["y"] + s["h"]), (sx, gap + LANE_CROSS), (tx, gap + LANE_CROSS), (tx, t["y"])]
            label_at = (sx, s["y"] + s["h"] + LABEL_BELOW)
        else:
            ch = right + CHANNEL * (channels + 1)
            channels += 1
            turn, enter = gap + LANE_FAR, row_top[row[e["to"]]] - ENTER_ABOVE
            pts = [(sx, s["y"] + s["h"]), (sx, turn), (ch, turn), (ch, enter), (tx, enter), (tx, t["y"])]
            label_at = (ch, (turn + enter) / 2)
        lines.append(
            {"edge": e, "d": path(pts), "lx": label_at[0], "ly": label_at[1],
             "lw": len(e["label"]) * LABEL_CHAR_W + 16 if e["label"] else 0}
        )  # fmt: skip

    width = right + MARGIN + (CHANNEL * channels + CHANNEL_PAD[0] if channels else 0)
    height = row_bottom[-1] + MARGIN + (CHANNEL_PAD[1] if channels else 0)
    return {"boxes": list(boxes.values()), "lines": lines, "questions": number, "width": width, "height": height}


def path(points: list[tuple[float, float]]) -> str:
    """An orthogonal route with softly rounded corners."""
    pts = [p for i, p in enumerate(points) if i == 0 or p != points[i - 1]]
    if len(pts) < 2:
        return ""
    d = f"M{pts[0][0]:.1f},{pts[0][1]:.1f}"
    for (px, py), (cx, cy), (nx, ny) in zip(pts, pts[1:], pts[2:]):
        r = min(8, (abs(cx - px) + abs(cy - py)) / 2, (abs(nx - cx) + abs(ny - cy)) / 2)
        ux, uy, vx, vy = sign(cx - px), sign(cy - py), sign(nx - cx), sign(ny - cy)
        d += f" L{cx - ux * r:.1f},{cy - uy * r:.1f} Q{cx:.1f},{cy:.1f} {cx + vx * r:.1f},{cy + vy * r:.1f}"
    return f"{d} L{pts[-1][0]:.1f},{pts[-1][1]:.1f}"


def render(value: dict) -> str:
    lay = layout(value)
    boxes = lay["boxes"]
    by_id = {b["node"]["id"]: b for b in boxes}

    # Every line first, every label after — a label is never struck through by a later line.
    edges, plates = [], []
    for line in lay["lines"]:
        e = line["edge"]
        ends = f'data-from="{esc(e["from"])}" data-to="{esc(e["to"])}"'
        edges.append(f'<g class="edge" {ends}><path d="{line["d"]}" class="line" marker-end="url(#ah)"/></g>')
        if e["label"]:
            plates.append(
                f'<g class="edge" {ends}><rect class="plate" x="{line["lx"] - line["lw"] / 2:.1f}" '
                f'y="{line["ly"] - PLATE_H / 2:.1f}" width="{line["lw"]:.1f}" height="{PLATE_H}" rx="{PLATE_H // 2}"/>'
                f'<text class="label" x="{line["lx"]:.1f}" y="{line["ly"]:.1f}">{esc(e["label"])}</text></g>'
            )

    nodes = []
    for b in boxes:
        n, x, y, w, h = b["node"], b["x"], b["y"], b["w"], b["h"]
        cx = x + w / 2
        if n["kind"] == "question":
            body = f'<path class="body" d="M{cx},{y} L{x + w},{y + h / 2} L{cx},{y + h} L{x},{y + h / 2} Z"/>'
        else:
            rx = h / 2 if n["kind"] == "start" else 10
            body = f'<rect class="body" x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}"/>'
        top = y + (h - len(b["lines"]) * LINE) / 2 + LINE * 0.72
        name = "".join(
            f'<text class="name" x="{cx}" y="{top + i * LINE:.1f}">{esc(line)}</text>' for i, line in enumerate(b["lines"])
        )
        num = (
            f'<circle class="num-bg" cx="{cx}" cy="{y}" r="11"/><text class="num" x="{cx}" y="{y + 0.5}">{b["n"]}</text>'
            if b["n"]
            else ""
        )
        nodes.append(f'<g class="node {n["kind"]}" data-id="{esc(n["id"])}" tabindex="0">{body}{name}{num}</g>')

    state_rows = "".join(
        f'<li data-for="{esc(b["node"]["id"])}"><span class="fact">'
        + (f'<span class="badge">{b["n"]}</span>' if b["n"] else "")
        + f'<span><b>{esc(b["node"]["label"])}</b><code>{esc(b["node"]["state"])}</code></span></span></li>'
        for b in boxes
        if b["node"]["state"]
    )
    note_rows = "".join(
        f'<li data-for="{esc(b["node"]["id"])}">{esc(b["node"]["note"])}<span class="about">'
        + (f'<span class="badge quiet">{b["n"]}</span>' if b["n"] else "")
        + f'{esc(b["node"]["label"])}</span></li>'
        for b in boxes
        if b["node"]["note"]
    ) + "".join(f"<li>{esc(note)}</li>" for note in value["notes"])

    def leads(node_id: str) -> str:
        return " · ".join(
            (f'{e["label"]} → ' if e["label"] else "→ ") + by_id[e["to"]]["node"]["label"]
            for e in value["edges"]
            if e["from"] == node_id
        )

    table_rows = "".join(
        f'<tr><td>{b["n"]}</td><td>{esc(b["node"]["label"])}</td><td>{esc(b["node"]["state"])}</td>'
        f'<td>{esc(leads(b["node"]["id"]))}</td><td>{esc(b["node"]["note"])}</td></tr>'
        for b in boxes
    )
    info = {
        b["node"]["id"]: {
            "n": b["n"], "label": b["node"]["label"], "kind": KIND_NAME[b["node"]["kind"]],
            "state": b["node"]["state"], "note": b["node"]["note"],
        }
        for b in boxes
    }  # fmt: skip

    def css_vars(tokens: dict[str, str]) -> str:
        return ";".join(f"{k}:{v}" for k, v in tokens.items())

    fill = {
        "__TITLE__": esc(value["title"]),
        "__DESC__": esc(value["description"]),
        "__SUMMARY__": f"{lay['questions']} questions · {len(boxes)} steps",
        "__LIGHT__": css_vars(LIGHT),
        "__DARK__": css_vars(DARK),
        "__EDGES__": "\n".join(edges + plates),
        "__NODES__": "\n".join(nodes),
        "__STATE__": f'<section class="fact-s"><h2>{ICON_FACT}State</h2><ul>{state_rows}</ul></section>' if state_rows else "",
        "__NOTES__": f'<section class="note"><h2>{ICON_NOTE}Notes</h2><ul>{note_rows}</ul></section>' if note_rows else "",
        "__TABLE__": table_rows,
        "__W__": f'{lay["width"]:.0f}',
        "__H__": f'{lay["height"]:.0f}',
        "__INFO__": json.dumps(info).replace("<", "\\u003c"),
    }
    return re.sub("|".join(fill), lambda m: fill[m.group(0)], PAGE)


ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
ICON_FACT = f'{ICON}<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>'
ICON_NOTE = f'{ICON}<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/></svg>'

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{__LIGHT__}
@media (prefers-color-scheme: dark){:root:not(.light){__DARK__}}
:root.dark,.dark{__DARK__}
*{box-sizing:border-box}
body{margin:0;background:var(--surface-0);color:var(--text-primary);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.page{max-width:1640px;margin:0 auto;padding:20px 16px 60px}
header{display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px;margin-bottom:16px}
header>div:first-child{flex:1;min-width:240px}
h1{margin:0;font-size:20px;font-weight:600}
.desc,.sum{margin:4px 0 0;color:var(--text-secondary);font-size:13px}
.desc{max-width:900px}
.desc:empty{display:none}
.toggle{display:inline-flex;background:var(--surface-2);border-radius:8px;padding:3px}
.toggle button{border:0;background:none;color:var(--text-secondary);font:inherit;font-size:13px;font-weight:500;padding:4px 12px;border-radius:6px;cursor:pointer}
.toggle button[aria-pressed=true]{background:var(--surface-1);color:var(--text-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.row{display:flex;align-items:flex-start;gap:16px}
.canvas{position:relative;flex:1;min-width:0;overflow:hidden;border:1px solid var(--hairline);border-radius:12px;background:var(--surface-1)}
.canvas svg{display:block;width:100%;height:calc(100vh - 170px);min-height:420px;touch-action:none;cursor:grab}
.zoom{position:absolute;top:10px;right:10px;display:flex;gap:4px;z-index:1}
.zoom button{border:1px solid var(--hairline-strong);background:var(--surface-1);color:var(--text-primary);border-radius:6px;height:28px;min-width:28px;padding:0 8px;font:inherit;font-size:12px;font-weight:500;cursor:pointer}
svg text{font-family:inherit}
.node .body{fill:var(--surface-1);stroke:var(--hairline-strong);stroke-width:1}
.node.question .body{stroke:var(--s1);stroke-width:1.5}
.node.start .body{fill:var(--surface-2)}
.node .name{fill:var(--text-primary);font-size:15px;font-weight:600;text-anchor:middle}
.node.hot .body,.node:focus-visible .body{stroke:var(--focus);stroke-width:2.5}
.node:focus{outline:none}
.num-bg{fill:var(--s1);stroke:var(--surface-1);stroke-width:2}
.num{fill:#fff;font-size:11px;font-weight:700;text-anchor:middle;dominant-baseline:central}
.edge .line{fill:none;stroke:var(--text-muted);stroke-width:1.5}
.edge .plate{fill:var(--surface-1);stroke:var(--hairline)}
.edge .label{fill:var(--text-secondary);font-size:12.5px;font-weight:600;text-anchor:middle;dominant-baseline:central}
.edge.hot .line{stroke:var(--focus);stroke-width:2.25}
#ah path{fill:var(--text-muted)}
aside{width:320px;flex-shrink:0;display:flex;flex-direction:column;gap:16px}
aside:empty{display:none}
aside section{border:1px solid var(--hairline);border-radius:12px;padding:12px;background:var(--surface-1)}
aside section.note{background:color-mix(in srgb,var(--side-note) 7%,var(--surface-1));border-color:color-mix(in srgb,var(--side-note) 35%,var(--surface-1));border-inline-start:3px solid var(--side-note)}
aside h2{margin:0 0 8px;display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}
aside .fact-s h2{color:var(--side-fact)} aside .note h2{color:var(--side-note)}
aside h2 svg{width:14px;height:14px}
aside ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
aside li{border:1px solid transparent;border-radius:6px;padding:6px 8px;font-size:13px}
.fact-s li.hot{border-color:var(--side-fact);background:color-mix(in srgb,var(--side-fact) 10%,var(--surface-1))}
.note li.hot{border-color:var(--side-note);background:color-mix(in srgb,var(--side-note) 16%,var(--surface-1))}
.fact{display:flex;gap:8px}.fact b{display:block;font-weight:600}
.fact code{display:block;margin-top:4px;padding:4px 6px;border-radius:4px;background:var(--surface-2);color:var(--text-secondary);font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace}
.badge{flex-shrink:0;margin-top:1px;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--side-fact);color:#fff;font-size:11px;font-weight:700}
.badge.quiet{width:16px;height:16px;margin:0;background:none;border:1px solid var(--hairline-strong);color:var(--text-secondary);font-size:10px}
.about{margin-top:4px;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted)}
.tablebox{display:none;overflow:auto;border:1px solid var(--hairline);border-radius:12px;background:var(--surface-1)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:start;vertical-align:top;padding:8px 12px;border-bottom:1px solid var(--hairline)}
th{color:var(--text-secondary);font-weight:600;font-size:12px}
body.table .row{display:none} body.table .tablebox{display:block}
#tip{position:fixed;z-index:10;display:none;pointer-events:none;max-width:320px;border:1px solid var(--hairline-strong);border-radius:8px;background:var(--surface-1);padding:8px 10px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.18)}
#tip b{display:block;font-size:13px}#tip .k{display:block;margin-top:2px;color:var(--text-secondary)}#tip .n{display:block;margin-top:4px;color:var(--text-muted)}
@media (max-width:900px){.row{flex-direction:column}aside{width:100%}}
</style></head>
<body><div class="page">
<header><div><h1>__TITLE__</h1><p class="desc">__DESC__</p><p class="sum">__SUMMARY__</p></div>
<div class="toggle" role="group" aria-label="View"><button id="v-chart" aria-pressed="true">Diagram</button><button id="v-table" aria-pressed="false">Table</button></div></header>
<div class="row">
<div class="canvas"><div class="zoom"><button id="z-fit">Fit</button><button id="z-out" aria-label="Zoom out">−</button><button id="z-in" aria-label="Zoom in">+</button></div>
<svg id="svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="__TITLE__">
<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1,1 L9,5 L1,9 Z"/></marker></defs>
<g>__EDGES__</g>
<g>__NODES__</g></svg></div>
<aside>__STATE____NOTES__</aside></div>
<div class="tablebox"><table><thead><tr><th>#</th><th>Step</th><th>State</th><th>Leads to</th><th>Note</th></tr></thead><tbody>__TABLE__</tbody></table></div>
</div><div id="tip" role="tooltip"></div>
<script>
const W=__W__,H=__H__,INFO=__INFO__;
const svg=document.getElementById('svg'),tip=document.getElementById('tip');
let v={x:0,y:0,w:W,h:H};
const apply=()=>svg.setAttribute('viewBox',[v.x,v.y,v.w,v.h].join(' '));
// Fit = the full width from the top: a tall flow is panned down, never shrunk until it is unreadable.
const fit=()=>{const r=svg.getBoundingClientRect();if(!r.width)return;v={x:0,y:0,w:W,h:Math.min(H,W*r.height/r.width)};svg.setAttribute('preserveAspectRatio','xMidYMin meet');apply()};
const zoom=(f,cx,cy)=>{const r=svg.getBoundingClientRect();const fx=cx===undefined?.5:(cx-r.left)/r.width,fy=cy===undefined?.5:(cy-r.top)/r.height;
  const w=Math.min(W*4,Math.max(W/12,v.w*f)),h=w/v.w*v.h;v={x:v.x+(v.w-w)*fx,y:v.y+(v.h-h)*fy,w,h};apply()};
svg.addEventListener('wheel',e=>{e.preventDefault();if(e.ctrlKey||e.metaKey)zoom(e.deltaY>0?1.1:.9,e.clientX,e.clientY);else{const k=v.w/svg.getBoundingClientRect().width;v.x+=e.deltaX*k;v.y+=e.deltaY*k;apply()}},{passive:false});
let drag=null;
svg.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,v:{...v},k:v.w/svg.getBoundingClientRect().width};svg.setPointerCapture(e.pointerId)});
svg.addEventListener('pointermove',e=>{if(!drag)return;v.x=drag.v.x-(e.clientX-drag.x)*drag.k;v.y=drag.v.y-(e.clientY-drag.y)*drag.k;apply()});
svg.addEventListener('pointerup',()=>drag=null);svg.addEventListener('pointercancel',()=>drag=null);
document.getElementById('z-fit').onclick=fit;document.getElementById('z-in').onclick=()=>zoom(.8);document.getElementById('z-out').onclick=()=>zoom(1.25);
addEventListener('resize',fit);fit();
let lit=null;
const light=id=>{if(id===lit)return;lit=id;document.querySelectorAll('.hot').forEach(el=>el.classList.remove('hot'));if(!id)return;
  document.querySelectorAll('.node,[data-for]').forEach(el=>{if((el.dataset.id||el.dataset.for)===id)el.classList.add('hot')});
  document.querySelectorAll('.edge').forEach(el=>{if(el.dataset.from===id||el.dataset.to===id)el.classList.add('hot')})};
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
document.querySelectorAll('.node').forEach(el=>{
  // The tooltip is built once per node; a move only carries it along.
  const show=e=>{if(drag)return;const i=INFO[el.dataset.id];
    if(lit!==el.dataset.id||tip.style.display!=='block')tip.innerHTML='<b>'+(i.n?i.n+'. ':'')+esc(i.label)+'</b><span class="k">'+esc(i.kind)+(i.state?' · '+esc(i.state):'')+'</span>'+(i.note?'<span class="n">'+esc(i.note)+'</span>':'');
    light(el.dataset.id);tip.style.display='block';tip.style.left=Math.min(innerWidth-328,e.clientX+14)+'px';tip.style.top=Math.max(8,e.clientY-72)+'px'};
  const hide=()=>{tip.style.display='none';light(null)};
  el.addEventListener('pointermove',show);el.addEventListener('pointerleave',hide);
  el.addEventListener('focus',()=>{const r=el.getBoundingClientRect();show({clientX:r.right,clientY:r.top+72})});el.addEventListener('blur',hide)});
document.querySelectorAll('aside li[data-for]').forEach(el=>{el.addEventListener('pointerenter',()=>light(el.dataset.for));el.addEventListener('pointerleave',()=>light(null))});
const view=t=>{document.body.classList.toggle('table',t);document.getElementById('v-table').setAttribute('aria-pressed',t);document.getElementById('v-chart').setAttribute('aria-pressed',!t);if(!t)fit()};
document.getElementById('v-chart').onclick=()=>view(false);document.getElementById('v-table').onclick=()=>view(true);
</script></body></html>
"""


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("folder", type=Path, help="the chart folder")
    parser.add_argument("--out", type=Path, help="where to write the file (default: <folder>/<folder name>.html)")
    args = parser.parse_args(argv)
    folder = args.folder.resolve()
    try:
        value = read(folder)
    except (OSError, ValueError) as e:
        print(json.dumps({"chart": str(folder), "ok": False, "errors": [f"{SOURCE}: {e}"]}))
        return 1
    if not value["nodes"]:
        print(json.dumps({"chart": str(folder), "ok": False, "errors": [f"{SOURCE}: no nodes"]}))
        return 1
    target = args.out or folder / f"{folder.name}.html"
    page = render(value)
    target.write_text(page, encoding="utf-8")
    print(json.dumps({"chart": str(folder), "ok": True, "html": str(target), "bytes": len(page.encode("utf-8"))}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
