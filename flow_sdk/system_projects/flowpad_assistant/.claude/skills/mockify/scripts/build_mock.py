"""Assemble a real-mode mock into ONE self-contained HTML file — one captured screen per step.

Usage:
  python -I build_mock.py <mock-dir> --row <mock-row.json> --step <id>=<capture.html> [--step ...]
                          --key <mock slug> --project <mock project id> [--template id=<capture.html> ...]
                          [--states <states.js>] [--title '<page title>'] [--origin http://localhost:6003]
                          [--html-attrs '<attrs>'] [--head '<extra head html>']

Each capture is a file written by capture_recv.py: "<!--styles-->…<!--body-->…". The --step ids must be the
row's journey, in order — a step with no screen stops the build; there is no base screen to fall back to.
Every --step becomes a <section data-step="<id>"> with that capture's body; the journey bar shows one at a
time. The page also carries the journey (MOCKIFY.journey), so it walks with no Flowpad behind it.

Self-contained: <mock-dir>/app.css is inlined; every url(...) / src / href naming a file in <mock-dir> (after
--origin is stripped) becomes a data: URI; the app's own <script> tags are stripped.

--states (optional, small tweaks only) defines `window.mockStates = {<step id>: (screen, need) => {...}}`;
each runs once on its own section. `need(selector)` returns the element or throws; a throw shows a red banner
on that screen instead of a silently unchanged one.

Writes <mock-dir>/index.html and, once, <mock-dir>/webapp.json (serve with `flow app serve`).
"""

import argparse
import base64
import json
import mimetypes
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import tree as mock_tree  # noqa: E402 -- the mock tree: validated and compiled here, walked by assets/mock-tree.js
from tree import PRESETS, load_row  # noqa: E402, F401 -- load_row is re-exported: validate_mock and test_md read rows the same way
SKIP = ("http:", "https:", "data:", "blob:", "#", "%23", "//", "/sdk/", "about:", "mailto:", "javascript:")


def fail(msg: str) -> None:
    sys.exit(f"build_mock: {msg}")


class Inliner:
    """Turns file references into data: URIs. The one path rule: with the app's origin stripped, a path is
    looked up under the mock dir (an app-root `/assets/x.png` as `assets/x.png`). What is not there stays as is;
    validate_mock.py reports any such file a screen actually loads."""

    def __init__(self, root: pathlib.Path, origin: str):
        self.root, self.origin, self.cache = root, origin.rstrip("/") + "/" if origin else "", {}

    def uri(self, ref: str) -> str | None:
        if self.origin and ref.startswith(self.origin):
            ref = ref[len(self.origin):]
        clean = ref.split("#")[0].split("?")[0].lstrip("/")
        if not clean or ref.startswith(SKIP):
            return None
        if clean not in self.cache:
            path = (self.root / clean).resolve()
            if not path.is_file() or self.root.resolve() not in path.parents:
                self.cache[clean] = None
            else:
                kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                self.cache[clean] = f"data:{kind};base64,{base64.b64encode(path.read_bytes()).decode()}"
        return self.cache[clean]

    def __call__(self, text: str) -> str:
        def css(m):
            u = self.uri(m.group(2))
            return f"url({m.group(1)}{u}{m.group(1)})" if u else m.group(0)

        def attr(m):
            u = self.uri(m.group(3))
            return f"{m.group(1)}={m.group(2)}{u}{m.group(2)}" if u else m.group(0)

        # An inline style attribute carries its quotes escaped: url(&quot;…&quot;) — React writes mask-image that way.
        text = re.sub(r"""url\((&quot;|['"]?)((?:(?!&quot;)[^'")])+)\1\)""", css, text)
        return re.sub(r"""\b(src|href|xlink:href)=(["'])([^"']+)\2""", attr, text)


def load(path: pathlib.Path) -> tuple[list[str], str]:
    if not path.is_file():
        fail(f"no capture at {path}")
    styles, _, body = path.read_text().partition("<!--body-->")
    # The app's own scripts (theme switchers, analytics) must not run inside the mock.
    body = re.sub(r"<script\b[^>]*>.*?</script>", "", body, flags=re.S | re.I)
    if not body.strip():
        fail(f"{path} has no body — was it captured with __cap()?")
    blocks = re.findall(r"<style\b[^>]*>.*?</style>", styles, flags=re.S | re.I)
    return blocks, body


STATES_RUNNER = """
(() => {
  const fns = window.mockStates || {};
  for (const [id, fn] of Object.entries(fns)) {
    const screen = document.querySelector(`[data-step="${CSS.escape(id)}"]`);
    const need = (sel) => { const el = screen && screen.querySelector(sel); if (!el) throw new Error(`no element "${sel}"`); return el; };
    try {
      if (!screen) throw new Error('no such screen');
      fn(screen, need);
    } catch (e) {
      console.error(`mockify: screen "${id}" tweak failed:`, e);
      const b = document.createElement('div');
      b.setAttribute('data-mockify-error', '');
      b.style.cssText = 'position:sticky;top:0;z-index:2147483646;background:#b91c1c;color:#fff;font:600 13px system-ui;padding:8px 12px';
      b.textContent = `mockify: screen "${id}" is not what was planned — ${e.message}`;
      (screen || document.body).prepend(b);
    }
  }
})();
"""


# A phone step is laid out at its device's own size, 1:1, in a frame (templates/fast-mock/device-frame.css).
# The presets are data (assets/devices.json): add a device there, not here.
DEVICES = {k: (v["width"], v["height"]) for k, v in PRESETS.items()}
FRAME_CSS = HERE.parent / "templates" / "fast-mock" / "device-frame.css"


def to_container_css(css: str) -> str:
    """One document, many screen sizes: a width media query answers the browser window, not the phone. Turn
    width queries into container queries (every screen is a `mk-screen` container), viewport units into
    container units, and the safe-area insets into the frame's --mk-safe-* — so a 390px step gets its 390px
    rules, dvh and insets, and a desktop step its own width's."""
    def media(m):
        q = re.sub(r"^\s*(only\s+)?screen\s+and\s+", "", m.group(1))
        return f"@container mk-screen {q}{{" if re.fullmatch(r"(\s*(and\s+)?\((min|max)-width:[^)]*\)\s*)+", q) else m.group(0)
    css = re.sub(r"@media\s+([^{]+)\{", media, css)
    css = re.sub(r"(\d*\.?\d+)[dsl]?vh\b", r"\1cqh", css)
    css = re.sub(r"(\d*\.?\d+)[dsl]?vw\b", r"\1cqw", css)
    return re.sub(r"env\(\s*safe-area-inset-(top|bottom|left|right)\s*(,[^)]*)?\)", r"var(--mk-safe-\1, 0px)", css)


def device_section(sid: str, device: str, body: str, hidden: bool) -> str:
    d = PRESETS[device]
    w = d["width"]
    frame = (f'--mk-w:{w}px;--mk-h:{d["height"]}px;--mk-safe-top:{d["safe_top"]}px;'
             f'--mk-safe-bottom:{d["safe_bottom"]}px;--mk-r:{d["radius"]}px')
    body = re.sub(r'style="([^"]*)"', lambda m: f'style="{to_container_css(m.group(1))}"', body)
    return (f'<section data-step="{sid}" data-device="{device}" data-mk-w="{w + 72}"{" hidden" if hidden else ""}>\n'
            f'<div class="mk-device" data-device="{device}" data-camera="{d["camera"]}" style="{frame}"><div class="mk-screen">\n{body}\n</div>'
            f'<div class="mk-home"></div></div>\n</section>')


def fit_to_width(width: int, focus_x: int, min_zoom: float) -> str:
    """A capture reflows when its frame is narrower than the window it came from: the Flowpad display is about
    half a screen, so tabs shrink to icons and the screen reads as empty. Lay each screen out at the captured
    width and zoom it down to the frame instead — but never below `min_zoom`, or the subject becomes unreadable;
    past that the screen scrolls sideways, opened on `focus_x` (the captured x of what is being discussed).
    The journey bar sits outside the sections and keeps its size."""
    if not width:
        return ""
    return f"""
<style>section[data-step]{{width:{width}px;min-height:100vh;position:relative}}html,body{{overflow:hidden}}
section[data-device]{{width:auto;min-height:0}}</style>
<script>(() => {{
  // Captured apps lay out on position:fixed roots, which never scroll; a transform on the section both
  // anchors them to it and shifts the screen sideways onto focus_x when it is still wider than the frame.
  const fit = () => document.querySelectorAll('section[data-step]').forEach((s) => {{
      // a phone step is shown 1:1 in its frame; it only shrinks when the frame is narrower than the phone
      const w = +s.dataset.mkW || {width}, z = Math.max(s.dataset.mkW ? 0.5 : {min_zoom}, Math.min(1, innerWidth / w));
      s.style.zoom = z; if (s.dataset.mkW) return; s.style.minHeight = `${{100 / z}}vh`; s.style.minHeight = `${{100 / z}}vh`;
      // zoom shrinks the app's own viewport heights too (#root / .h-screen at 100vh end at zoom x the frame and
      // leave dead space under the screen) — whatever selector set them. Stretch every box that starts at the
      // screen's top and ends at the shrunk height back to the frame.
      s.querySelectorAll('[data-mk-fill]').forEach((e) => {{ e.style.removeProperty('height'); e.removeAttribute('data-mk-fill'); }});
      if (z < 1) {{ const top = s.getBoundingClientRect().top, shrunk = innerHeight * z;
        for (const e of s.querySelectorAll('*')) {{
          const r = e.getBoundingClientRect();
          if (r.top - top > 2) continue;
          if (Math.abs(r.height - shrunk) < 2) {{ e.style.setProperty('height', `${{innerHeight / z}}px`, 'important'); e.setAttribute('data-mk-fill', ''); }}
        }} }}
      // a screen whose subject sits elsewhere sets its own: mockStates may write screen.dataset.focusX
      const d = Math.max(0, Math.min(w * z - innerWidth, (+s.dataset.focusX || {focus_x}) * z - innerWidth / 2));
      s.style.transform = d > 0 ? `translateX(${{-d / z}}px)` : ''; }});
  window.mockifyFit = fit;   // the journey bar calls it on every step: a hidden screen has no boxes to measure
  addEventListener('resize', fit); addEventListener('DOMContentLoaded', fit);
}})();</script>"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mock_dir")
    ap.add_argument("--step", action="append", default=[], help="<step id>=<capture.html>, once per step, in journey order")
    ap.add_argument("--row", required=True, help="the mock row as JSON: every journey step needs a --step, and the page carries the journey")
    ap.add_argument("--template", action="append", default=[])
    ap.add_argument("--states", help="optional per-screen tweaks (window.mockStates)")
    ap.add_argument("--key", required=True, help="the mock row key in the mocks dataset")
    ap.add_argument("--project", required=True, help="the mock project id (mock_project.py ensure)")
    ap.add_argument("--origin", default="")
    ap.add_argument("--html-attrs", default='lang="en" class="dark"')
    ap.add_argument("--head", default="")
    ap.add_argument("--title", default="Mock")
    ap.add_argument("--width", type=int, default=0,
                    help="the capture window's width (info.json viewport.w): each screen is laid out at it and "
                         "scaled to fit a narrower frame, such as the Flowpad display")
    ap.add_argument("--focus-x", type=int, default=0,
                    help="with --width: the captured x of what the mock is about; kept in view when the frame is too narrow "
                         "(a screen overrides it with screen.dataset.focusX in its mockStates tweak)")
    ap.add_argument("--min-zoom", type=float, default=0.7, help="with --width: never scale a screen below this")
    a = ap.parse_args()

    mock = pathlib.Path(a.mock_dir)
    if not a.step:
        fail("no --step given: every screen of the journey is its own capture")
    steps = []
    for spec in a.step:
        sid, _, src = spec.partition("=")
        if not sid or not src:
            fail(f"--step {spec!r}: expected <id>=<capture.html>")
        if any(s[0] == sid for s in steps):
            fail(f"step {sid!r} given twice")
        steps.append((sid, src))
    row = load_row(a.row)
    compiled, problems = mock_tree.check(row)   # a bad tree stops the build: nothing is built on a guess
    if problems:
        fail("the mock tree has problems (scripts/tree.py validate):\n  - " + "\n  - ".join(problems))
    journey = compiled["screens"]        # the screens in DFS order, each with its persona and device resolved
    devices = {j["id"]: j["device"] for j in journey}
    personas = {j["id"]: j["persona"] for j in journey}
    planned, given = [j["id"] for j in journey], [s[0] for s in steps]
    if planned != given:
        fail(f"--step ids {given} must be the tree's screens in DFS order (tree.py show): {planned}")

    inline = Inliner(mock, a.origin)
    styles: dict[str, None] = {}   # captures share most of their styles: each block once, in order
    parts = []
    for n, (sid, src) in enumerate(steps):
        blocks, body = load(pathlib.Path(src))
        styles.update(dict.fromkeys(blocks))
        if devices[sid] in DEVICES:
            section = device_section(sid, devices[sid], body, n > 0)
        else:
            section = f'<section data-step="{sid}"{"" if n == 0 else " hidden"}>\n{body}\n</section>'
        if personas[sid]:
            section = section.replace("<section ", f'<section data-persona="{personas[sid]}" ', 1)
        parts.append(section)
    for tid, _, src in (t.partition("=") for t in a.template):
        blocks, body = load(pathlib.Path(src))
        styles.update(dict.fromkeys(blocks))
        parts.append(f'<template id="{tid}">{body}</template>')

    app_css = mock / "app.css"
    css = f"<style>{app_css.read_text()}</style>" if app_css.is_file() else ""
    states = pathlib.Path(a.states).read_text() + STATES_RUNNER if a.states else ""
    bar = (HERE.parent / "assets" / "journey-bar.js").read_text()
    walker = (HERE.parent / "assets" / "mock-tree.js").read_text()
    config = json.dumps({"key": a.key, "project": a.project, "tree": compiled,
                         "schemas": str(pathlib.Path(a.mock_dir).resolve().parents[1] / "data_schema"),
                         "personas": row.get("personas") or [], "persona": row.get("persona") or "",
                         "device": row.get("device") or "desktop"}, ensure_ascii=False).replace("</", "<\\/")

    page_css = css + "\n" + "\n".join(styles)
    if any(d in DEVICES for d in devices.values()):
        # every screen answers its own size: a desktop step is a container at its captured width
        page_css = (to_container_css(page_css) + f"<style>{FRAME_CSS.read_text()}</style>"
                    + "<style>section[data-step]:not([data-device]){container-type:inline-size;container-name:mk-screen}</style>")
    page_head = inline(page_css) + fit_to_width(a.width, a.focus_x, a.min_zoom)
    page_body = inline("\n".join(parts))
    html = f"""<!doctype html>
<html {a.html_attrs}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{a.title}</title>
<style>[data-decision]{{outline:2px dashed #bf8700;outline-offset:3px}}</style>
{a.head}
{page_head}
<style>/* A capture is a still: an open dialog's enter animation would replay from opacity 0 and stall there. */
section[data-step] *,section[data-step] *::before,section[data-step] *::after{{animation:none!important;transition:none!important}}</style>
</head>
<body>
{page_body}
<script>window.MOCKIFY = {config}; window.MOCK_BAR_AT = "bottom";</script>
{f"<script>{states}</script>" if states else ""}
<script>{walker}</script>
<script>{bar}</script>
</body></html>"""
    (mock / "index.html").write_text(html)
    manifest = mock / "webapp.json"
    if not manifest.exists():
        manifest.write_text(json.dumps({"name": mock.name, "title": a.title, "build": ".",
                                        "description": "A clickable journey mock (mockify, real mode)."}, indent=2) + "\n")
    print(json.dumps({"wrote": str(mock / "index.html"), "bytes": len(html), "screens": given}, indent=2))


if __name__ == "__main__":
    main()
