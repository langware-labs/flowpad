"""Assemble a real-mode mock into ONE self-contained HTML file — one captured screen per step.

Usage:
  python -I build_mock.py <mock-dir> --step <id>=<capture.html> [--step ...] --key <mock slug>
                          --project <mock project id> [--row <mock-row.json>] [--template id=<capture.html> ...]
                          [--states <states.js>] [--title '<page title>'] [--origin http://localhost:6003]
                          [--html-attrs '<attrs>'] [--head '<extra head html>']

Each capture is a file written by capture_recv.py: "<!--styles-->…<!--body-->…". Every --step becomes a
<section data-step="<id>"> holding that capture's body; the journey bar shows one at a time. --row (the mock
row's value, `{"journey": [...]}` or the row with `input`) makes a journey step with no --step an error —
there is no base screen to fall back to.

Self-contained: <mock-dir>/app.css is inlined as a <style>; every relative url(...) / src / href that names a
file in <mock-dir> (icons, PNGs, fonts) becomes a data: URI; the app's own <script> tags are stripped. What
stays outside the file is printed (an /api/ image, a font link) so you can decide.

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
SKIP = ("http:", "https:", "data:", "blob:", "#", "/", "about:", "mailto:", "javascript:")


def fail(msg: str) -> None:
    sys.exit(f"build_mock: {msg}")


class Inliner:
    """Turns relative file references into data: URIs; remembers what it could not."""

    def __init__(self, root: pathlib.Path):
        self.root, self.cache, self.missing = root, {}, set()

    def uri(self, ref: str) -> str | None:
        clean = ref.split("#")[0].split("?")[0]
        if not clean or ref.startswith(SKIP):
            return None
        if clean not in self.cache:
            path = (self.root / clean).resolve()
            if not path.is_file() or self.root.resolve() not in path.parents:
                self.missing.add(clean)
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

        text = re.sub(r"""url\((['"]?)([^'")]+)\1\)""", css, text)
        return re.sub(r"""\b(src|href|xlink:href)=(["'])([^"']+)\2""", attr, text)


def load(path: pathlib.Path, origin: str) -> tuple[list[str], str]:
    if not path.is_file():
        fail(f"no capture at {path}")
    text = path.read_text()
    if origin:
        text = text.replace(origin.rstrip("/") + "/", "")
    text = re.sub(r'(["(])/(assets|icons)/', r"\1\2/", text)
    styles, _, body = text.partition("<!--body-->")
    # The app's own scripts (theme switchers, analytics) must not run inside the mock.
    body = re.sub(r"<script\b[^>]*>.*?</script>", "", body, flags=re.S | re.I)
    if not body.strip():
        fail(f"{path} has no body — was it captured with __cap()?")
    blocks = re.findall(r"<style\b[^>]*>.*?</style>", styles, flags=re.S | re.I)
    return blocks, body


def journey_ids(row_path: str) -> list[str]:
    row = json.loads(pathlib.Path(row_path).read_text())
    if isinstance(row, list):          # DM ds-rows prints a list of rows
        row = row[0] if row else {}
    row = row.get("input", row)
    return [s["id"] for s in row.get("journey", [])]


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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mock_dir")
    ap.add_argument("--step", action="append", default=[], help="<step id>=<capture.html>, once per step, in journey order")
    ap.add_argument("--row", help="the mock row value as JSON; every journey step must then have a --step")
    ap.add_argument("--template", action="append", default=[])
    ap.add_argument("--states", help="optional per-screen tweaks (window.mockStates)")
    ap.add_argument("--key", required=True, help="the mock row key in the mocks dataset")
    ap.add_argument("--project", required=True, help="the mock project id (mock_project.py ensure)")
    ap.add_argument("--origin", default="")
    ap.add_argument("--html-attrs", default='lang="en" class="dark"')
    ap.add_argument("--head", default="")
    ap.add_argument("--title", default="Mock")
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
    if a.row:
        missing = [i for i in journey_ids(a.row) if i not in {s[0] for s in steps}]
        if missing:
            fail(f"journey steps with no screen: {', '.join(missing)} — capture or build each one")

    inline = Inliner(mock)
    style_blocks, sections = [], []
    for n, (sid, src) in enumerate(steps):
        blocks, body = load(pathlib.Path(src), a.origin)
        style_blocks += [b for b in blocks if b not in style_blocks]   # captures share most of their styles
        hidden = "" if n == 0 else " hidden"
        sections.append(f'<section data-step="{sid}"{hidden}>\n{body}\n</section>')
    templates = [f'<template id="{tid}">{load(pathlib.Path(src), a.origin)[1]}</template>'
                 for tid, _, src in (t.partition("=") for t in a.template)]

    app_css = mock / "app.css"
    css = f"<style>{re.sub(r'(["(])/(assets|icons)/', r'\1\2/', app_css.read_text())}</style>" if app_css.is_file() else ""
    states = pathlib.Path(a.states).read_text() + STATES_RUNNER if a.states else ""
    bar = (HERE.parent / "assets" / "journey-bar.js").read_text()

    page_head = inline(css + "\n" + "\n".join(style_blocks))
    page_body = inline("\n".join(sections) + "".join(templates))
    html = f"""<!doctype html>
<html {a.html_attrs}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{a.title}</title>
<style>[data-decision]{{outline:2px dashed #bf8700;outline-offset:3px}}</style>
{a.head}
{page_head}
</head>
<body>
{page_body}
<script>window.MOCKIFY = {{key: {json.dumps(a.key)}, project: {json.dumps(a.project)}}}; window.MOCK_BAR_AT = "bottom";</script>
{f"<script>{states}</script>" if states else ""}
<script>{bar}</script>
</body></html>"""
    (mock / "index.html").write_text(html)
    manifest = mock / "webapp.json"
    if not manifest.exists():
        manifest.write_text(json.dumps({"name": mock.name, "title": a.title, "build": ".",
                                        "description": "A clickable journey mock (mockify, real mode)."}, indent=2) + "\n")
    print(json.dumps({"wrote": str(mock / "index.html"), "bytes": len(html), "screens": [s[0] for s in steps],
                      "not_inlined": sorted(inline.missing)}, indent=2))


if __name__ == "__main__":
    main()
