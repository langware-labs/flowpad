# CLAUDE.md

**This deck template is managed by the FlowPad Assistant via the `decker`
skill. Invoke that skill for ANY operation** — adding or editing layouts,
re-skinning the design tokens, generating a deck, or presenting it. The
`decker` reference docs are the source of truth for how this template works.

Full agent instructions and the contracts you must preserve live in
[AGENTS.md](AGENTS.md) — read it before changing anything.

Quick facts: layouts are isolated HTML fragments in `layouts/`; all visuals
come from `common/tokens.css` + `common/theme.css` (no Reveal theme CSS);
decks are assembled into ONE self-contained HTML file via
`python3 tools/build_deck.py <deck.json> -o <out.html>`.
