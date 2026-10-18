"""Assemble a real-mode mock from captured pages.

Usage:
  python -I build_mock.py <mock-dir> --base <capture.html> [--template id=<capture.html> ...]
                          --states <states.js> --key <mock slug> [--title '<page title>']
                          [--origin http://localhost:6003] [--html-attrs '<attrs>'] [--head '<extra head html>']

<mock-dir> must already hold the app's compiled CSS as app.css and its asset folders (icons/, assets/).
Each capture is a file written by capture_recv.py: "<!--styles-->…<!--body-->…".
The base capture becomes the page; each --template capture is embedded as <template id="…"> for the
states script to clone from. Absolute URLs on --origin are made relative, so the mock serves on its own.
Writes <mock-dir>/index.html and <mock-dir>/webapp.json (the folder is a Flowpad web app: serve it with
`flow app serve`). The journey is NOT in the page: the journey bar reads the mock row `--key` names.
"""

import argparse
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent


def load(path: pathlib.Path, origin: str) -> tuple[str, str]:
    text = path.read_text()
    if origin:
        text = text.replace(origin.rstrip("/") + "/", "")
    text = re.sub(r'(["(])/(assets|icons)/', r"\1\2/", text)
    styles, _, body = text.partition("<!--body-->")
    # The app's own scripts (theme switchers, analytics) must not run inside the mock.
    body = re.sub(r"<script\b[^>]*>.*?</script>", "", body, flags=re.S | re.I)
    return styles.replace("<!--styles-->", ""), body


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mock_dir")
    ap.add_argument("--base", required=True)
    ap.add_argument("--template", action="append", default=[])
    ap.add_argument("--states", required=True)
    ap.add_argument("--key", required=True, help="the mock row key in the mocks dataset")
    ap.add_argument("--project", required=True, help="the mock project id (mock_project.py ensure)")
    ap.add_argument("--origin", default="")
    ap.add_argument("--html-attrs", default='lang="en" class="dark"')
    ap.add_argument("--head", default="")
    ap.add_argument("--title", default="Mock")
    a = ap.parse_args()

    mock = pathlib.Path(a.mock_dir)
    styles, body = load(pathlib.Path(a.base), a.origin)
    templates = []
    for spec in a.template:
        tid, _, src = spec.partition("=")
        templates.append(f'<template id="{tid}">{load(pathlib.Path(src), a.origin)[1]}</template>')
    states = pathlib.Path(a.states).read_text()
    bar = (HERE.parent / "assets" / "journey-bar.js").read_text()

    html = f"""<!doctype html>
<html {a.html_attrs}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{a.title}</title>
<link rel="stylesheet" href="app.css">
<style>[data-decision]{{outline:2px dashed #bf8700;outline-offset:3px}}</style>
{a.head}
{styles}
</head>
<body>
{body}
{''.join(templates)}
<script>window.MOCKIFY = {{key: {json.dumps(a.key)}, project: {json.dumps(a.project)}}}; window.MOCK_BAR_AT = "bottom";</script>
<script>{states}</script>
<script>{bar}</script>
</body></html>"""
    (mock / "index.html").write_text(html)
    manifest = mock / "webapp.json"
    if not manifest.exists():
        manifest.write_text(json.dumps({"name": mock.name, "title": a.title, "build": ".",
                                        "description": "A clickable journey mock (mockify, real mode)."}, indent=2) + "\n")
    print(f"wrote {mock / 'index.html'} ({len(html)} bytes)")


if __name__ == "__main__":
    main()
