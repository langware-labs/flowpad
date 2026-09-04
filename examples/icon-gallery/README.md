# Icon gallery

Every icon this backend serves, drawn by the SDK — the showcase for
`flow_sdk/icons` and `ts_sdk/src/icons`.

```bash
uv run -m flow_sdk.server.run                                  # a backend, in one shell
cd ui && npx vite --config vite.icon-gallery.config.ts         # the page, in another
```

Then open the printed URL. Point it at a different instance with
`?api=http://localhost:PORT`.

The page talks to a running backend on purpose: the packs come from
`GET /api/v1/graph/icons` and the artwork from the `/icons` static mount, so what
you are looking at is the real delivery path rather than a copy of it.

Nothing here draws an icon itself. Every glyph comes out of `@sdk/icons` —
`useIcon` on the React surfaces, `iconElement` on the ones that demonstrate no
framework is needed. The two columns in *React and no-React* agree because there
is one resolver underneath and both are thin wrappers over it.

What it demonstrates, on the real packs:

| Section | Shows |
|---|---|
| The packs | carried vs. declared families; a bundle pack lists nothing |
| Sub-icons | `@restore` composed from `sub: { restore: 'lucide:history' }`, plus ad-hoc badges |
| Chips | the glyph with its label, as an inbox row wears it — full and compact |
| Colour on a bundle glyph | a lucide mask taking any colour, incl. the terminal strip's per-vendor tints |
| Tinting | `tintable` picks mask vs `<img>`; a mask follows `currentColor`, an image cannot |
| Declared colour | a brand's own hex, in the pack instead of at the call site |
| Theme | a `dark` variant chosen by CSS, across all three viewer states |
| React and no-React | the same refs through both entry points |
| Fallbacks | a typo resolves to `none` — not to a plausible wrong glyph |

The chip section is the one that matters most: at 14px beside 10px text on a
muted plate is where a wrong glyph or an untinted brand mark is obvious, in a way
a 26px tile never makes it.

The gallery uses Flowpad's own theme tokens (copied from `ui/src/styles/index.css`)
so the icons are judged against the surface they actually ship on.
