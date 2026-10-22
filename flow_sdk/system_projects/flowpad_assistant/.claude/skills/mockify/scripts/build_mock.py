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

        text = re.sub(r"""url\((['"]?)([^'")]+)\1\)""", css, text)
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


def load_row(row_path: str) -> dict:
    """The mock row's value from a file: the value itself, a row with `input`, or `DM ds-rows` output."""
    row = json.loads(pathlib.Path(row_path).read_text())
    if isinstance(row, dict) and "rows" in row:
        row = row["rows"]
    if isinstance(row, list):
        row = row[0] if row else {}
    return row.get("input", row)


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
    ap.add_argument("--row", required=True, help="the mock row as JSON: every journey step needs a --step, and the page carries the journey")
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
    journey = load_row(a.row).get("journey", [])
    planned, given = [j["id"] for j in journey], [s[0] for s in steps]
    if planned != given:
        fail(f"--step ids {given} must be the journey's steps in order: {planned}")

    inline = Inliner(mock, a.origin)
    styles: dict[str, None] = {}   # captures share most of their styles: each block once, in order
    parts = []
    for n, (sid, src) in enumerate(steps):
        blocks, body = load(pathlib.Path(src))
        styles.update(dict.fromkeys(blocks))
        parts.append(f'<section data-step="{sid}"{"" if n == 0 else " hidden"}>\n{body}\n</section>')
    for tid, _, src in (t.partition("=") for t in a.template):
        blocks, body = load(pathlib.Path(src))
        styles.update(dict.fromkeys(blocks))
        parts.append(f'<template id="{tid}">{body}</template>')

    app_css = mock / "app.css"
    css = f"<style>{app_css.read_text()}</style>" if app_css.is_file() else ""
    states = pathlib.Path(a.states).read_text() + STATES_RUNNER if a.states else ""
    bar = (HERE.parent / "assets" / "journey-bar.js").read_text()

    page_head = inline(css + "\n" + "\n".join(styles))
    page_body = inline("\n".join(parts))
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
<script>window.MOCKIFY = {{key: {json.dumps(a.key)}, project: {json.dumps(a.project)}, journey: {json.dumps(journey)}}}; window.MOCK_BAR_AT = "bottom";</script>
{f"<script>{states}</script>" if states else ""}
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
