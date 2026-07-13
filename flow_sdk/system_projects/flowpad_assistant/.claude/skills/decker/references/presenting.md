# Presenting a deck

## Inside FlowPad

```bash
flow show file "<absolute path to deck>.html"
```

Run it exactly once — exit 0 means the Vibe display is now rendering the deck.
`show` drives the calling process's display; it never moves the user's browser
tab (that would be `flow navigate`, which is not needed here).

### How the render works (and what it forbids)

Flowpad renders a shown `.html` in an iframe with `sandbox="allow-scripts"`
and the file injected as `srcDoc`:

- **No base URL / no same-origin** → relative `src`/`href` resolve to nothing
  and network fetches are blocked. The deck must stay a single self-contained
  file (the assembler guarantees this — don't hand-edit external refs in).
- **No `localStorage`, no URL hash/history** → Reveal runs with
  `hash: false, history: false` (set in the template's `common/deck.js`).
  Deep-linking to a slide number is not available in-display.
- **Fullscreen** may be blocked (the host iframe doesn't grant the fullscreen
  permission). Overview and keyboard navigation work normally.

Do not name a deck `*.mcp.html` — that extension routes to the MCP-Apps
renderer, not the plain HTML preview.

### Reveal controls (headless config)

- ←/→ (or Space): previous/next slide; Home/End: first/last.
- `Esc` or `O`: overview grid; `F`: fullscreen (browser tab only, see above).
- `S`: speaker/presenter view — opens a popup; works when the deck is opened
  directly in a browser tab, not inside the sandboxed display.

## Outside FlowPad

Print the absolute path and suggest opening it directly in a browser
(`open <path>` on macOS). In a real tab the deck is unrestricted: fullscreen,
presenter view, and hash navigation all work — the file is fully portable
(mail it, drop it in Slack; it carries its media inside).

## Optional: register the deck as a result

Registering is additive (results list), not the display driver:

```
<flow-result name="<Deck title>" path="assets/decks/<deck name>/<deck name>.html" ref_type="FILE" type="report" description="Slide deck built from <template name>"/>
```
