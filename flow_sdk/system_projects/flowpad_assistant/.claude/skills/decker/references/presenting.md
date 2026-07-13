# Presenting a deck

## Inside FlowPad

```bash
flow record index "<project root>"
flow show file "<project root>/assets/decks/<deck name>"   # the FOLDER
```

Run `show` once — exit 0 means the display is now rendering the deck. Because the
deck is a `deck` entity (its folder carries a `deck.json` marker), showing the
**folder** resolves to the entity and opens the bespoke **deck viewer**, which
frames the deck full-bleed (no white letterbox), grants fullscreen, and links to
the source template. `show` drives the calling process's display; it never moves
the user's browser tab.

### The deck viewer

- The deck (a self-contained Reveal HTML) renders in a 16:9 frame centered in a
  dark surface — Reveal always sees a 16:9 container, so no white gutters.
- **Fullscreen**: the viewer's ⛶ button (or Reveal's `F` — the viewer's iframe
  grants the fullscreen permission). Reveal's own arrows/keys/overview drive the
  slides inside.
- **Open in a new tab**: the ↗ button opens the portable file in a real browser
  tab, where presenter view (`S`) and everything else is unrestricted.
- **Template**: a link back to the `deck_template` this deck was built from.

Reveal runs headless with `hash:false, history:false` (set in `common/deck.js`)
because the deck renders in a sandboxed `srcDoc` iframe (no same-origin, no URL
hash). Do not name a deck `*.mcp.html` — that routes to the MCP-Apps renderer.

### Reveal controls

- ←/→ (or Space): previous/next slide; Home/End: first/last.
- `Esc` or `O`: overview grid; `F`: fullscreen; `S`: presenter view (new-tab only).

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
