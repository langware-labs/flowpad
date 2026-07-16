#!/usr/bin/env python3
"""make_style_picker.py — build the one-click style picker as an .mcp.html.

    python3 tools/make_style_picker.py -o <scratchpad>/decker-style.mcp.html

Then: `flow show file <that path>` (exit 0 = shown) and STOP. The user's click
arrives as a fresh prompt to this agent.

Stdlib only, by design — this runs on every user's machine.

Why a tool and not hand-written HTML: the MCP App sandbox serves exactly ONE
file (the .mcp.html) under `img-src data: blob:`. Sidecar images, file:// paths
and https:// URLs are all blocked, so every preview must be base64-inlined —
and no agent should be hand-authoring ~1MB of base64.

Interaction: single click, no submit button. The click handler fires
`ui/update-model-context` then `ui/message` (that order matters — ui/message is
the handoff) exactly once, then locks the grid.
"""
from __future__ import annotations

import argparse
import base64
import html
import json
import os
import sys

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STYLES = os.path.join(SKILL, "styles")
SHOTS = os.path.join(SKILL, "screenshots")

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pick a deck style</title>
<style>
  :root {
    --paper: #ffffff; --ink: #16181d; --ink-2: #5a5f6b; --ink-3: #8a8f9c;
    --line: #e4e5e9; --sel: #0d6e63;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #14161b; --ink: #eef0f5; --ink-2: #a6abb8; --ink-3: #767c8a;
      --line: #282c36; --sel: #4fd1c0;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 18px; background: var(--paper); color: var(--ink);
    font-family: var(--sans); -webkit-font-smoothing: antialiased;
  }
  h1 { font-size: 17px; margin: 0 0 3px; letter-spacing: -0.01em; }
  .sub { font-size: 13px; color: var(--ink-2); margin: 0 0 16px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); }
  .card {
    display: block; width: 100%; padding: 0; text-align: left; cursor: pointer;
    background: var(--paper); border: 1px solid var(--line); border-radius: 10px;
    overflow: hidden; font: inherit; color: inherit;
    transition: transform .14s ease, border-color .14s ease, box-shadow .14s ease;
  }
  .card:hover, .card:focus-visible {
    transform: translateY(-2px); border-color: var(--sel);
    box-shadow: 0 8px 20px rgba(0,0,0,.14);
  }
  .card:focus-visible { outline: 2px solid var(--sel); outline-offset: 2px; }
  .card img { display: block; width: 100%; height: auto; border-bottom: 1px solid var(--line); }
  .meta { padding: 10px 12px 12px; }
  .name { font-size: 14.5px; font-weight: 600; letter-spacing: -0.01em; }
  .fam {
    font-family: var(--mono); font-size: 10px; letter-spacing: .08em;
    text-transform: uppercase; color: var(--ink-3); margin: 3px 0 6px;
  }
  .desc { font-size: 12.5px; color: var(--ink-2); line-height: 1.45; margin: 0; }
  body.locked .card { pointer-events: none; opacity: .35; }
  body.locked .card.chosen { opacity: 1; border-color: var(--sel); border-width: 2px; }
  .status {
    margin-top: 14px; font-family: var(--mono); font-size: 12px; color: var(--sel);
    min-height: 1.2em;
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div data-testid="mcp-ui-root">
  <h1>Pick a deck style</h1>
  <p class="sub">One click and I'll build the deck. Each preview shows the same
  cover and metrics slide, so you're comparing design, not content.</p>
  <div class="grid">
__CARDS__
  </div>
  <p class="status" data-testid="mcp-ui-submission-status" role="status" aria-live="polite"></p>
</div>
<script>
const mcp = (() => {
  let nextId = 1;
  const pending = new Map();
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0' || !Object.prototype.hasOwnProperty.call(msg, 'id')) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || 'MCP request failed'));
    else waiter.resolve(msg.result || {});
  });
  function request(method, params) {
    const id = nextId++;
    parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  function notify(method, params) {
    parent.postMessage({ jsonrpc: '2.0', method, params: params || {} }, '*');
  }
  return {
    async connect() {
      await request('ui/initialize', {
        appInfo: { name: 'decker-style-picker', version: '1.0.0' },
        appCapabilities: {},
        protocolVersion: '2026-01-26'
      });
      notify('ui/notifications/initialized', {});
    },
    updateModelContext: (p) => request('ui/update-model-context', p),
    sendMessage: (p) => request('ui/message', p),
    sizeChanged: () => notify('ui/notifications/size-changed', {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight
    })
  };
})();

// ui/message must fire exactly once — the host prompts the agent per message.
let sent = false;
async function choose(slug, name) {
  if (sent) return;
  sent = true;
  document.body.classList.add('locked');
  const card = document.querySelector('[data-slug="' + slug + '"]');
  if (card) card.classList.add('chosen');
  const status = document.querySelector('[data-testid="mcp-ui-submission-status"]');
  status.textContent = name + ' selected — submitted. Building your deck…';
  try {
    await mcp.updateModelContext({ selectedStyle: slug, styleName: name });
    await mcp.sendMessage({
      content: [{ type: 'text',
        text: 'MCP_UI_SUBMISSION ' + JSON.stringify({ selectedStyle: slug }) }]
    });
  } catch (e) {
    // Delivery is fire-and-forget upstream; surface nothing alarming.
    console.error('[decker] style submission failed', e);
  }
}

// Handlers registered BEFORE connect(), per the mcp-ui contract.
document.querySelectorAll('.card').forEach((el) => {
  el.addEventListener('click', () => choose(el.dataset.slug, el.dataset.name));
});
mcp.connect().then(() => mcp.sizeChanged()).catch((e) =>
  console.error('[decker] mcp connect failed', e));
</script>
</body>
</html>
"""

CARD = """    <button class="card" type="button" data-slug="{slug}" data-name="{name}"
            data-testid="mcp-ui-style-{slug}" aria-label="Choose the {name} style">
      <img src="data:image/png;base64,{b64}" alt="{name}: cover and metrics slide" />
      <span class="meta">
        <span class="name">{name}</span>
        <span class="fam">{family}</span>
        <p class="desc">{desc}</p>
      </span>
    </button>"""


def die(msg):
    sys.stderr.write("make_style_picker: error: %s\n" % msg)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description="Build the decker style picker.")
    ap.add_argument("-o", "--out", required=True,
                    help="output path; MUST end in .mcp.html to route to the "
                         "MCP-Apps renderer")
    args = ap.parse_args()
    if not args.out.endswith(".mcp.html"):
        die("--out must end in .mcp.html (a plain .html renders as a static "
            "preview with no agent bridge, so clicks go nowhere)")

    if not os.path.isdir(STYLES):
        die("no styles/ directory at %s" % STYLES)

    styles = []
    for slug in os.listdir(STYLES):
        meta_path = os.path.join(STYLES, slug, "style.json")
        if not os.path.isfile(meta_path):
            continue
        shot = os.path.join(SHOTS, slug + ".png")
        if not os.path.isfile(shot):
            die("style %r has no screenshot at screenshots/%s.png — regenerate "
                "with: uv run --with playwright python tools/make_style_shots.py"
                % (slug, slug))
        meta = json.load(open(meta_path, encoding="utf-8"))
        meta["slug"] = slug
        meta["shot"] = shot
        styles.append(meta)
    if not styles:
        die("styles/ contains no style.json manifests")

    styles.sort(key=lambda s: (s.get("order", 999), s["slug"]))

    cards = []
    for s in styles:
        with open(s["shot"], "rb") as f:
            raw = f.read()
        cards.append(CARD.format(
            slug=s["slug"],
            name=html.escape(s.get("name", s["slug"]), quote=True),
            family=html.escape(s.get("family", ""), quote=False),
            desc=html.escape(s.get("description", ""), quote=False),
            b64=base64.b64encode(raw).decode("ascii")))

    out = PAGE.replace("__CARDS__", "\n".join(cards))
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(out)

    size = os.path.getsize(args.out) / 1024.0
    sys.stderr.write("make_style_picker: wrote %s (%d styles, %.0f KB)\n"
                     % (args.out, len(styles), size))
    if size > 3072:
        sys.stderr.write(
            "make_style_picker: warning: %.1f MB crosses two postMessage hops "
            "and may render slowly; consider smaller screenshots\n"
            % (size / 1024.0))


if __name__ == "__main__":
    main()
