"""What every chart format's `export_html.py` shares: the page around the drawing.

A format's exporter owns its layout and its drawing; this file owns the theme tokens, the page
shell (header, Diagram / Table switch, zoom buttons, tooltip), pan and zoom, reading CHART.md, and
the command line. An exporter loads it by path (the three `importlib` lines at its top), because the
scripts run with `python3 -I`, which keeps their folder off `sys.path`. Standard library only.

The look mirrors Flowpad's chart editor (ui/src/components/assets/editor/chart/chartTheme.ts) — keep
the tokens in step with it.
"""

import argparse
import html
import json
import re
from pathlib import Path
from typing import Callable

LIGHT = {
    "--surface-0": "#f4f3f0", "--surface-1": "#fcfcfb", "--surface-2": "#f0efec",
    "--text-primary": "#0b0b0b", "--text-secondary": "#52514e", "--text-muted": "#8a8984",
    "--hairline": "#e3e2de", "--hairline-strong": "#c9c8c2", "--s1": "#2a78d6", "--focus": "#2a78d6",
}  # fmt: skip
DARK = {
    "--surface-0": "#121211", "--surface-1": "#1a1a19", "--surface-2": "#252523",
    "--text-primary": "#f0efec", "--text-secondary": "#c3c2b7", "--text-muted": "#8f8e88",
    "--hairline": "#2e2e2b", "--hairline-strong": "#44443f", "--s1": "#3987e5", "--focus": "#3987e5",
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


def read_json(folder: Path, source: str) -> dict:
    data = json.loads((folder / source).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("not an object")
    return data


def heading(folder: Path, data: dict) -> dict:
    """The chart's title and description: the file's own title, else CHART.md's, else the folder."""
    doc = folder / "CHART.md"
    md = doc.read_text(encoding="utf-8", errors="replace") if doc.is_file() else ""

    def front(key: str) -> str:
        # A long value folds onto indented lines; they are part of it.
        m = re.search(rf"^{key}:\s*(.+(?:\n[ \t]+.+)*)$", md, re.M)
        return " ".join(m.group(1).split()).strip("'\"") if m else ""

    return {"title": text(data.get("title")) or front("name") or folder.name, "description": front("description")}


SHELL_CSS = """*{box-sizing:border-box}
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
.canvas{position:relative;flex:1;min-width:0;overflow:hidden;border:1px solid var(--hairline);border-radius:12px;background:var(--surface-1)}
.canvas svg{display:block;width:100%;height:calc(100vh - 170px);min-height:420px;touch-action:none;cursor:grab}
.zoom{position:absolute;top:10px;right:10px;display:flex;gap:4px;z-index:1}
.zoom button{border:1px solid var(--hairline-strong);background:var(--surface-1);color:var(--text-primary);border-radius:6px;height:28px;min-width:28px;padding:0 8px;font:inherit;font-size:12px;font-weight:500;cursor:pointer}
svg text{font-family:inherit}
.tablebox{display:none;overflow:auto;border:1px solid var(--hairline);border-radius:12px;background:var(--surface-1)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:start;vertical-align:top;padding:8px 12px;border-bottom:1px solid var(--hairline)}
th{color:var(--text-secondary);font-weight:600;font-size:12px}
body.table .tablebox{display:block}
#tip{position:fixed;z-index:10;display:none;pointer-events:none;max-width:320px;border:1px solid var(--hairline-strong);border-radius:8px;background:var(--surface-1);padding:8px 10px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.18)}
#tip b{display:block;font-size:13px}#tip .k{display:block;margin-top:2px;color:var(--text-secondary)}#tip .n{display:block;margin-top:4px;color:var(--text-muted)}"""

HEADER = """<header><div><h1>__TITLE__</h1><p class="desc">__DESC__</p><p class="sum">__SUMMARY__</p></div>
<div class="toggle" role="group" aria-label="View"><button id="v-chart" aria-pressed="true">Diagram</button><button id="v-table" aria-pressed="false">Table</button></div></header>"""

ZOOM = '<div class="zoom"><button id="z-fit">Fit</button><button id="z-out" aria-label="Zoom out">−</button><button id="z-in" aria-label="Zoom in">+</button></div>'

# Needs the page's own `W` and `H` (the drawing's size) and an <svg id="svg">; leaves `svg`, `tip`,
# `drag` and `esc` for the format's script that follows it.
SHELL_JS = """const svg=document.getElementById('svg'),tip=document.getElementById('tip');
let v={x:0,y:0,w:W,h:H};
const apply=()=>svg.setAttribute('viewBox',[v.x,v.y,v.w,v.h].join(' '));
// Fit = the full width from the top: a tall chart is panned down, never shrunk until it is unreadable.
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
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const view=t=>{document.body.classList.toggle('table',t);document.getElementById('v-table').setAttribute('aria-pressed',t);document.getElementById('v-chart').setAttribute('aria-pressed',!t);if(!t)fit()};
document.getElementById('v-chart').onclick=()=>view(false);document.getElementById('v-table').onclick=()=>view(true);"""

_SHELL = {"__SHELL_CSS__": SHELL_CSS, "__HEADER__": HEADER, "__ZOOM__": ZOOM, "__SHELL_JS__": SHELL_JS}


def page(template: str) -> str:
    """A format's page template with the shared pieces put in; its own `__X__` marks are left for `fill`."""
    return re.sub("|".join(_SHELL), lambda m: _SHELL[m.group(0)], template)


def fill(template: str, value: dict, light: dict, dark: dict, marks: dict) -> str:
    """The finished page: the heading, the two themes, and the format's own marks."""
    css_vars = lambda tokens: ";".join(f"{k}:{v}" for k, v in tokens.items())  # noqa: E731
    marks = {
        "__TITLE__": esc(value["title"]),
        "__DESC__": esc(value["description"]),
        "__THEME__": f":root{{{css_vars(light)}}}\n@media (prefers-color-scheme: dark){{:root:not(.light){{{css_vars(dark)}}}}}\n:root.dark,.dark{{{css_vars(dark)}}}",
        **marks,
    }
    return re.sub("|".join(marks), lambda m: marks[m.group(0)], template)


def run(argv: list[str], doc: str, source: str, needs: str, read: Callable, render: Callable) -> int:
    """The command line every exporter has: `<chart folder> [--out <file.html>]`, one JSON line out.
    `needs` is the list in the chart's value that must not be empty."""
    parser = argparse.ArgumentParser(description=doc.splitlines()[0])
    parser.add_argument("folder", type=Path, help="the chart folder")
    parser.add_argument("--out", type=Path, help="where to write the file (default: <folder>/<folder name>.html)")
    args = parser.parse_args(argv)
    folder = args.folder.resolve()
    try:
        value = read(folder)
    except (OSError, ValueError) as e:
        print(json.dumps({"chart": str(folder), "ok": False, "errors": [f"{source}: {e}"]}))
        return 1
    if not value[needs]:
        print(json.dumps({"chart": str(folder), "ok": False, "errors": [f"{source}: no {needs}"]}))
        return 1
    target = args.out or folder / f"{folder.name}.html"
    out = render(value)
    target.write_text(out, encoding="utf-8")
    print(json.dumps({"chart": str(folder), "ok": True, "html": str(target), "bytes": len(out.encode("utf-8"))}))
    return 0
