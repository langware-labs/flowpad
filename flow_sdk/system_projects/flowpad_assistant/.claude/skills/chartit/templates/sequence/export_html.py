"""Write a sequence chart as ONE self-contained HTML file — the copy that opens anywhere.

Usage: python3 -I export_html.py <chart folder> [--out <file.html>]

Reads the folder's chart.json (and CHART.md for the name and description) and writes
`<chart folder>/<folder name>.html`: the lanes, the numbered messages, hover, zoom and a Table view,
in light and dark. Positions are worked out here and written into the file, and each participant's
icon is inlined from its icon pack, so the file loads nothing from the network. A sub-flow (`ref`) is
drawn as a block naming the chart it stands for; it is not a link, since the file stands alone.
Prints one JSON line. Standard library only.

The look mirrors Flowpad's chart editor (ui/src/components/assets/editor/chart: chartTheme.ts,
SequenceChartView.tsx) — keep the tokens and styles below in step with it. The layout is this
script's own, so sizes can differ from what the editor draws.
"""

import importlib.util
import json
import re
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location("export_page", Path(__file__).resolve().parents[1] / "export_page.py")
shared = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shared)
wrap, text, esc = shared.wrap, shared.text, shared.esc

HEAD_W, HEAD_H, COL_GAP, MARGIN, TOP = 230, 66, 44, 32, 50
LINE, SUB_LINE, LABEL_CHAR_W, META_CHAR_W = 17, 15, 6.9, 6.6
SELF_W, SELF_H, TAIL = 44, 30, 40
SOURCE = "chart.json"
SLOTS = ["--s1", "--s2", "--s3", "--s4"]  # a 5th+ participant is neutral, never cycled

LIGHT = {**shared.LIGHT, "--s2": "#eb6834", "--s3": "#1baf7a", "--s4": "#6250d6", "--s-other": "#8a8984"}
DARK = {**shared.DARK, "--s2": "#d95926", "--s3": "#199e70", "--s4": "#9085e9", "--s-other": "#8f8e88"}


def first_line(value: str, chars: int) -> str:
    return (wrap(value, chars, 1) or [""])[0]


def icon_svg(tag: str, folder: Path) -> str:
    """The inner markup of the icon `<pack>.<icon>`, or "" when it cannot be found or is not plain
    drawing. Looked up in the packs Flowpad ships, then in an icon pack asset above the chart."""
    pack, _, name = tag.partition(".")
    if not re.fullmatch(r"[\w-]+", pack) or not re.fullmatch(r"[\w-]+", name):
        return ""
    roots = [Path(__file__).resolve().parents[7] / "server" / "icons" / pack]
    roots += [up / "agentic-assets" / "icon_pack" / pack for up in folder.parents]
    for root in roots:
        file = root / "assets" / f"{name}.svg"
        if not file.is_file():
            continue
        inner = re.search(r"<svg[^>]*>(.*)</svg>", file.read_text(encoding="utf-8", errors="replace"), re.S)
        if inner and not re.search(r"<script|\son\w+=|href=|url\(", inner.group(1), re.I):
            return inner.group(1).strip()
    return ""


def read(folder: Path) -> dict:
    """The chart as plain data; a malformed entry is dropped, like the editor does."""
    data = shared.read_json(folder, SOURCE)
    people, seen = [], set()
    for item in data.get("participants") or []:
        pid = text(item.get("id")) if isinstance(item, dict) else ""
        if not pid or pid in seen:
            continue
        seen.add(pid)
        people.append(
            {"id": pid, "label": text(item.get("label")) or pid, "sublabel": text(item.get("sublabel")),
             "note": text(item.get("note")), "icon": icon_svg(text(item.get("icon")), folder)}
        )  # fmt: skip
    messages = [
        {"from": m["from"], "to": m["to"], "label": text(m.get("label")), "note": text(m.get("note")),
         "dashed": m.get("style") == "dashed", "ref": text(m.get("ref")), "returns": text(m.get("returns"))}
        for m in data.get("messages") or []
        if isinstance(m, dict) and m.get("from") in seen and m.get("to") in seen
    ]  # fmt: skip
    return {**shared.heading(folder, data), "participants": people, "messages": messages}


def layout(value: dict) -> dict:
    """Lanes left to right, messages top to bottom. A message's label sits above its arrow; a
    self-call is a loop to the right of its lane with the label beside it. Each row carries
    everything `render` draws: the arrow, the label plate, the lines under it and its hover note."""
    col = HEAD_W + COL_GAP
    lane = {p["id"]: MARGIN + HEAD_W / 2 + i * col for i, p in enumerate(value["participants"])}
    y = TOP + HEAD_H + 34
    rows = []
    for n, m in enumerate(value["messages"], 1):
        x1, x2 = lane[m["from"]], lane[m["to"]]
        own = x1 == x2
        span = HEAD_W + 10 if own else abs(x2 - x1) - 28
        lines = wrap(m["label"] or ("sub-flow" if m["ref"] else ""), max(18, int(span / LABEL_CHAR_W)), 2) or [""]
        extra = [f"sub-flow · {m['ref']}"] if m["ref"] else []
        extra += [f"returns {m['returns']}"] if m["returns"] else []
        lw = max(len(s) for s in lines + extra) * LABEL_CHAR_W + 16
        lh = len(lines) * LINE + 6
        if own:
            y += 6
            lx, ly, foot = x1 + SELF_W + 12 + lw / 2, y + SELF_H / 2 - lh / 2, y + SELF_H
            step = max(SELF_H, lh) + 26
        else:
            y += lh + 8
            lx, ly, foot = (x1 + x2) / 2, y - 8 - lh, y
            step = 22
        rows.append(
            {"n": n, "m": m, "x1": x1, "x2": x2, "y": y, "own": own, "lines": lines, "extra": extra,
             "lx": lx, "ly": ly, "lw": lw, "lh": lh, "foot": foot,
             "detail": " · ".join(extra + ([m["note"]] if m["note"] else []))}
        )  # fmt: skip
        y += step + len(extra) * SUB_LINE
    widest = max((r["lx"] + r["lw"] / 2 for r in rows if r["own"]), default=0)
    width = max(MARGIN * 2 + HEAD_W + max(0, len(lane) - 1) * col, widest + MARGIN)
    return {"lane": lane, "rows": rows, "width": width, "height": y + TAIL}


def render(value: dict) -> str:
    lay = layout(value)
    lane, bottom = lay["lane"], lay["height"] - TAIL / 2
    people = value["participants"]
    slot = {p["id"]: f"var({SLOTS[i]})" if i < len(SLOTS) else "var(--s-other)" for i, p in enumerate(people)}
    arrow = {p["id"]: f"ah-{i}" for i, p in enumerate(people)}  # an id may hold anything; a marker's may not
    name = {p["id"]: p["label"] for p in people}

    heads, lifes, marks = [], [], []
    for p in people:
        pid, cx = esc(p["id"]), lane[p["id"]]
        x = cx - HEAD_W / 2
        tx = x + (58 if p["icon"] else 30)
        chars = int((HEAD_W - (tx - x) - 10) / META_CHAR_W)
        label, sub = first_line(p["label"], chars), first_line(p["sublabel"], chars)
        icon = (
            f'<svg class="ico" x="{x + 26}" y="{TOP + HEAD_H / 2 - 11}" width="22" height="22" viewBox="0 0 24 24" '
            f'fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{p["icon"]}</svg>'
            if p["icon"]
            else ""
        )
        heads.append(
            f'<g class="p" data-id="{pid}" tabindex="0">'
            f'<rect class="head" x="{x}" y="{TOP}" width="{HEAD_W}" height="{HEAD_H}" rx="12"/>'
            f'<circle cx="{x + 14}" cy="{TOP + HEAD_H / 2}" r="5" fill="{slot[p["id"]]}"/>{icon}'
            f'<text class="name" x="{tx}" y="{TOP + (28 if sub else 38)}">{esc(label)}</text>'
            f'<text class="meta" x="{tx}" y="{TOP + 47}">{esc(sub)}</text></g>'
        )
        lifes.append(f'<line class="life" x1="{cx}" y1="{TOP + HEAD_H}" x2="{cx}" y2="{bottom}"/>')
        marks.append(
            f'<marker id="{arrow[p["id"]]}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto" '
            f'markerUnits="userSpaceOnUse"><path d="M1,1 L9,5 L1,9 Z" fill="{slot[p["id"]]}"/></marker>'
        )

    msgs = []
    for r in lay["rows"]:
        m, y, x1, x2 = r["m"], r["y"], r["x1"], r["x2"]
        colour = slot[m["from"]]
        left, top = r["lx"] - r["lw"] / 2, r["ly"]
        if r["own"]:
            right, low = x1 + SELF_W, y + SELF_H
            d = f"M{x1},{y} H{right - 8} Q{right},{y} {right},{y + 8} V{low - 8} Q{right},{low} {right - 8},{low} H{x1 + 2}"
        else:
            right = max(x1, x2)
            d = f"M{x1},{y} H{x2 - (2 if x2 > x1 else -2)}"
        block = ""
        if m["ref"]:
            lo, hi = min(x1, x2, left) - 14, max(right, left + r["lw"]) + 14
            height = r["foot"] + 22 + len(r["extra"]) * SUB_LINE - (top - 8)
            block = f'<rect class="block" x="{lo}" y="{top - 8}" width="{hi - lo}" height="{height}" rx="12"/>'
        label = "".join(
            f'<text class="lbl" x="{r["lx"]}" y="{top + 3 + LINE * (i + 0.72):.1f}">{esc(s)}</text>'
            for i, s in enumerate(r["lines"])
        ) + "".join(
            f'<text class="sub" x="{r["lx"]}" y="{r["foot"] + 16 + i * SUB_LINE}">{esc(s)}</text>'
            for i, s in enumerate(r["extra"])
        )
        msgs.append(
            f'<g class="m" data-n="{r["n"]}" data-from="{esc(m["from"])}" data-to="{esc(m["to"])}" tabindex="0">{block}'
            f'<path class="line{" dashed" if m["dashed"] else ""}" d="{d}" stroke="{colour}" marker-end="url(#{arrow[m["from"]]})"/>'
            f'<rect class="plate" x="{left:.1f}" y="{top:.1f}" width="{r["lw"]:.1f}" height="{r["lh"]}" rx="6"/>{label}'
            f'<circle class="num-bg" cx="{x1}" cy="{y}" r="10" fill="{colour}"/><text class="num" x="{x1}" y="{y + 0.5}">{r["n"]}</text></g>'
        )

    table = "".join(
        f'<tr><td>{r["n"]}</td><td>{esc(name[r["m"]["from"]])}</td><td>{esc(name[r["m"]["to"]])}</td>'
        f'<td>{esc(r["m"]["label"])}{" ↩" if r["m"]["dashed"] else ""}</td><td>{esc(r["detail"])}</td></tr>'
        for r in lay["rows"]
    )
    info = {
        "m": {
            r["n"]: {"label": r["m"]["label"], "path": f'{name[r["m"]["from"]]} → {name[r["m"]["to"]]}', "note": r["detail"]}
            for r in lay["rows"]
        },
        "p": {p["id"]: {"label": p["label"], "sub": p["sublabel"], "note": p["note"]} for p in people},
    }
    marks = {
        "__SUMMARY__": f'{len(people)} participants · {len(lay["rows"])} messages',
        "__MARKS__": "".join(marks),
        "__LIFES__": "\n".join(lifes),
        "__MSGS__": "\n".join(msgs),
        "__HEADS__": "\n".join(heads),
        "__TABLE__": table,
        "__W__": f'{lay["width"]:.0f}',
        "__H__": f'{lay["height"]:.0f}',
        "__INFO__": json.dumps(info).replace("<", "\\u003c"),
    }
    return shared.fill(PAGE, value, LIGHT, DARK, marks)


PAGE = shared.page(
    """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
__THEME__
__SHELL_CSS__
.p .head{fill:var(--surface-1);stroke:var(--hairline-strong);stroke-width:1}
.p .name{fill:var(--text-primary);font-size:14px;font-weight:600}
.p .meta{fill:var(--text-secondary);font-size:11.5px}
.p .ico{stroke:var(--text-secondary)}
.life{stroke:var(--hairline-strong);stroke-width:1}
.m .line{fill:none;stroke-width:1.75;stroke-linecap:round}
.m .line.dashed{stroke-dasharray:6 5}
.m .plate{fill:var(--surface-1);stroke:var(--hairline)}
.m .lbl{fill:var(--text-primary);font-size:12.5px;font-weight:600;text-anchor:middle}
.m .sub{fill:var(--text-muted);font-size:11.5px;text-anchor:middle}
.m .block{fill:var(--surface-2);stroke:var(--hairline-strong);stroke-dasharray:4 3}
.m .num-bg{stroke:var(--surface-1);stroke-width:2}
.m .num{fill:#fff;font-size:10.5px;font-weight:700;text-anchor:middle;dominant-baseline:central}
.m.hot .line{stroke-width:3}.m.hot .plate{stroke:var(--focus);stroke-width:2}
.p.hot .head,.p:focus-visible .head,.m:focus-visible .plate{stroke:var(--focus);stroke-width:2}
.p:focus,.m:focus{outline:none}
svg.dim .m:not(.hot){opacity:.28}
body.table .canvas{display:none}
</style></head>
<body><div class="page">
__HEADER__
<div class="canvas">__ZOOM__
<svg id="svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="__TITLE__">
<defs>__MARKS__</defs>
<g>__LIFES__</g>
<g>__MSGS__</g>
<g>__HEADS__</g></svg></div>
<div class="tablebox"><table><thead><tr><th>#</th><th>From</th><th>To</th><th>Message</th><th>Note</th></tr></thead><tbody>__TABLE__</tbody></table></div>
</div><div id="tip" role="tooltip"></div>
<script>
const W=__W__,H=__H__,INFO=__INFO__;
__SHELL_JS__
const clear=()=>{document.querySelectorAll('.hot').forEach(el=>el.classList.remove('hot'));svg.classList.remove('dim');tip.style.display='none'};
const place=e=>{tip.style.left=Math.max(8,Math.min(innerWidth-328,e.clientX+14))+'px';tip.style.top=Math.max(8,e.clientY+16)+'px'};
// The tooltip and the highlight are set once on the way in; a move only carries the tooltip along.
const hover=(el,enter)=>{
  const show=e=>{if(drag)return;clear();el.classList.add('hot');tip.innerHTML=enter();tip.style.display='block';place(e)};
  el.addEventListener('pointerenter',show);el.addEventListener('pointermove',e=>{if(tip.style.display==='block')place(e)});el.addEventListener('pointerleave',clear);
  el.addEventListener('focus',()=>{const r=el.getBoundingClientRect();show({clientX:r.left,clientY:r.bottom})});el.addEventListener('blur',clear)};
const messages=document.querySelectorAll('.m');
messages.forEach(el=>hover(el,()=>{const i=INFO.m[el.dataset.n];
  return '<b>'+el.dataset.n+'. '+esc(i.label)+'</b><span class="k">'+esc(i.path)+'</span>'+(i.note?'<span class="n">'+esc(i.note)+'</span>':'')}));
document.querySelectorAll('.p').forEach(el=>hover(el,()=>{const i=INFO.p[el.dataset.id];svg.classList.add('dim');
  messages.forEach(m=>{if(m.dataset.from===el.dataset.id||m.dataset.to===el.dataset.id)m.classList.add('hot')});
  return '<b>'+esc(i.label)+'</b>'+(i.sub?'<span class="k">'+esc(i.sub)+'</span>':'')+(i.note?'<span class="n">'+esc(i.note)+'</span>':'')}));
</script></body></html>
"""
)


def main(argv: list[str]) -> int:
    return shared.run(argv, __doc__, SOURCE, "participants", read, render)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
