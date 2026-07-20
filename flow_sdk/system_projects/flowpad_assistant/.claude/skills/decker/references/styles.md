# Styles — the built-in design systems

A **style** is a complete design system: palette, type, and composition. A
**template** bakes in exactly one style at bootstrap. Picking a style is the
first thing this skill does (see [SKILL.md](../SKILL.md)); everything else
follows from it.

## The catalog

| slug | family | use it when |
|------|--------|-------------|
| `default` | Neutral dark | the content must carry everything; no point of view wanted |
| `editorial-ink` | Warm Editorial | you want to look considered — a report, a strategy memo, a board read |
| `swiss-signal` | Neo-Grid Bold | an exec audience; the most "designed" and the safest of the six |
| `terminal-core` | Terminal-Core | a developer audience. Deliberately narrow — wrong for a board meeting |
| `cinematic-noir` | Cinematic Dark | a keynote with the lights down |
| `neon-brutal` | Neon Brutalist | loud on purpose — a launch, not a QBR |
| `dusk-aurora` | Glass / Soft-Futurism | a product launch; soft, modern, dark |

Each ships `style.json` (name, family, description, `order`, `expect_face`),
`tokens.css`, and `style.css`, plus a committed preview at
`screenshots/<slug>.png` (a 2-up of the cover and metrics slide).

## The three CSS layers

`tools/build_deck.py` concatenates, in order:

```
reset.css + reveal.css + tokens.css + theme.css + style.css
                         ^^^^^^^^^^   ^^^^^^^^^   ^^^^^^^^^
                         the style    the base    the style
```

* **`tokens.css` — the vocabulary.** Colour, type scale, font stacks, spacing,
  radii. Changing a value here re-colours everything.
* **`theme.css` — the style-agnostic base.** Ships with the scaffold. Owns the
  Reveal reset, the helper classes (`.kicker`, `.card`, `.metric-value`, `.grid`)
  and the `decker:structural-fix` block. A style should rarely need to fight it.
* **`style.css` — the personality.** Where a style says what a `.card` **is**.
  This layer is why the catalog looks like six different design systems rather
  than one recoloured six ways: in four of them a card is not a box at all but a
  column under a rule.

Applying a style = overwrite `tokens.css` + `style.css`. Idempotent, so
re-styling an existing template is always safe. `style.css` is optional in the
assembler — templates built before styles existed still assemble.

**Layout fragments are never touched by a style.** All six styles were built
without editing a single layout. If a style needs a layout change, that is a
signal the layout has hardcoded design in it — fix the layout instead.

## Why `--font-display` matters most

The single highest-leverage token. A deck set entirely in `--font-sans` reads as
generic no matter how well it is coloured; a real display face does most of the
work of looking designed. The old token set had no way to express a typeface at
all, which is why every deck looked the same.

Give `--font-display` a real fallback **chain** that degrades to a *related*
face, never to `system-ui`:

```css
/* good — every step is an old-style serif */
--font-display: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;

/* bad — the first miss and the style is gone */
--font-display: "Iowan Old Style", system-ui, sans-serif;
```

A deck is a portable single file: the viewer is often not on the machine that
built it. The first names in these chains are macOS faces; the later ones cover
Windows and Linux. **No webfonts** — a deck must render with zero network.

## Adding or editing a style

1. `cp -R styles/swiss-signal styles/<new slug>` — start from the closest one.
2. Edit `tokens.css` and `style.css`. Set `style.json`'s `name`, `family`,
   `description` (one line, says *when to reach for it*), `order`, and
   `expect_face` (the family that must resolve — the guard against a silent
   fallback).
3. Regenerate the preview — **maintainer-only**, needs Playwright, which is not
   a Flowpad dependency:

   ```bash
   uv run --with playwright python -m playwright install chromium   # first run only
   uv run --with playwright python tools/make_style_shots.py --style <new slug>
   ```

   It fails loudly if the style renders a console error or if the display face
   fell back — a screenshot would otherwise hide both. Run it on macOS: the
   `expect_face` values name macOS-first faces.
4. Commit `screenshots/<new slug>.png`. Previews are **pre-generated**, never
   built at runtime: end users have neither Playwright nor a browser, and the
   MCP sandbox can only load images the picker base64-inlines from these files.

Keep shots ≤ ~100 KB — they ship in the wheel to every user, and the picker
inlines all of them into one file that crosses two `postMessage` hops.

## The picker

`tools/make_style_picker.py` (stdlib-only) reads `styles/*/style.json` +
`screenshots/*.png` and emits one `.mcp.html`. Single click, no submit button:
the handler fires `ui/update-model-context` then `ui/message` **exactly once**,
then locks the grid.

The `.mcp.html` suffix is what routes it to the MCP-Apps renderer with the agent
bridge — a plain `.html` renders as a static preview and clicks go nowhere. The
tool refuses any other extension.
