---
id: 644cb4d9-bfd4-4a33-81d5-345c9f7cce04
---

# Icons

One principle, and everything else follows from it: **the backend names the
glyph, the frontend resolves the name.** A type, a provider or a data source
publishes a string; nothing in the UI decides which picture a thing gets.

That principle held long before this system existed — what was missing was
anywhere that said which names are legal. `TypeMetadata.icon` stated the old
position outright: *"Free string by design: the set of valid lucide names lives
in the frontend's bundle, not here."* A misspelling was therefore invisible
until someone looked at a screen and saw the generic document glyph. The icon
registry is what closed that.

## Names are dot tags

An icon is named in the repo's one dot grammar — `flow_sdk/tags/grammar.py` and
its TS twin `ts_sdk/src/tags/grammar.ts`, the same grammar that serves bus tags
and the kind ontology. There is no second spelling.

```
brands.slack            a pack's icon
brands.claude.restore   a role — one more segment
lucide.rss              a declared family's member
Rss                     a bare legacy name; normalizes to a leaf tag
icons/my_type.svg       a path — a location, never a name
🎨                      not a tag at all; the value IS the glyph
```

**Collisions are not a concept.** Two packs may each declare `slack`; they are
`brands.slack` and `vendorx.slack`, and each is asked for by its full tag.
Nothing needs a precedence rule. A *bare* leaf (`slack`) is answered by whichever
pack has it first — arbitrary by definition, which is why a caller that cares
qualifies the tag.

**Resolution is best-match** — the deepest registered ancestor, which is exactly
`tag_ancestors`. `brands.claude.restore` resolves to itself when that role
exists and to `brands.claude` when it does not, because an icon is decoration
and a base glyph beats nothing.

That leniency has a cost, and the system pays it in one specific place: a
misspelled leaf on a valid path (`brands.slack.typo`) also degrades. So a
resolution reports the tag it ACTUALLY matched, and the fence test asserts
asked == matched. **Best-match at runtime, exact-match in CI** — graceful where
a person is looking, strict where a diff is.

## Packs

A pack is a namespace. It either carries artwork it enumerates, or *declares a
family* the renderer already has.

| Pack | Kind | Contents |
|---|---|---|
| `brands` | assets | 16 vendor marks |
| `flowpad` | assets | 6 of our own UI glyphs |
| `lucide` | bundle | declares the family; 64 files served |

They live at `flow_sdk/server/icons/<pack>/icon_pack.json` (+ `assets/`), are
served at `/icons` by the static mount in `flow_sdk/server/app.py`, and ship in
the wheel through the `server/icons/**/*` entry in `pyproject.toml`.

`lucide` lists **nothing**. Enumerating thousands of glyphs in a manifest would
be a second copy that drifts; instead the pack declares a `base` and the asset
is `<leaf>.svg` under it.

## The two shapes

`IconSpec` and `IconPackSpec` (`flow_sdk/schema/data_spec/icon_spec.py`) are
`DataSpec` subclasses, so `extra="forbid"` and `frozen` are inherited and a
misspelled manifest key is a load error.

| Field | Why it exists |
|---|---|
| `kind` | the leaf; the full tag is `<pack.kind>.<kind>` |
| `asset` | path under the pack's `base` |
| `tintable` | **picks the render strategy** — see below |
| `color` | a brand's own colour, declared once instead of at every call site |
| `dark` | artwork for a dark ground; CSS selects it, no caller asks |
| `sub` | role → the TAG of a glyph to badge on |
| `aliases` | the vocabulary is genuinely two vocabularies |
| `source` | where the artwork came from |

**`tintable` is not decoration — it picks how an icon renders**, and it is what
makes icons work outside React. A tintable glyph is a CSS mask over
`background-color: currentColor`, so it inherits colour the way text does. A
four-colour brand mark cannot: it is an `<img>`, and an `<img>` has no way to
take the text colour around it.

**`aliases` exist because the codebase speaks two vocabularies.** `TypeInfo` says
`ClaudeCode`, the process tables say `claude`, the connection catalogue says
`anthropic` — all three in shipped data. Aliasing them is how one registry
answers for all three without a rename.

**`sub` composes instead of drawing.** `{"restore": "lucide.history"}` means
`<tag>.restore` draws the icon with a history badge on its corner. This replaced
four hand-made `*RestoreIcon` components that differed only in which mark sat
under the same arrow — and which no fifth vendor ever got for free.

`dark` is only meaningful when `tintable` is false: masking discards the
artwork's colour, so a tintable glyph already inverts with the theme and a dark
variant of one is a contradiction.

## Rendering

```tsx
<FlowIcon icon="brands.slack" className="h-4 w-4" />   // rendered
flowIconComponent('brands.slack')                       // a stored value
```

`flowIconComponent(tag)` is the load-bearing one: it matches `lucideByName`'s
signature and return type, which is why the app's module-scope icon tables
could keep their shape. A React hook cannot be called at module scope, so a
component VALUE — not a hook — is the unit the app actually consumes.

Props come from what the app measurably does. `className` passes through on
every strategy (the app sizes with `h-N w-N` across ~1,600 sites), `size` takes
a named step **or** a pixel number (`EntityIcon` derives one from its density),
`color` overrides the spec's, `badge` adds an ad-hoc sub-icon, `fallback` takes a
ReactNode for the cases a tag cannot express, and the rest spreads.

Sizing defaults are wrapped in `:where()` — **zero specificity**. The stylesheet
is injected at runtime and therefore lands last in the cascade; a plain
`.fp-icon{width:1em}` would beat `h-4 w-4` at every call site.

Outside React, `iconElement(tag, packs)` returns an `HTMLElement` and
`iconChip(tag, label, packs)` the labelled pill an inbox row wears. `useIcon` is
for callers that need the *resolution* — which pack answered, whether best-match
degraded — rather than a glyph.

## The bundle seam

`ts_sdk` depends on `dotenv` and nothing else; it cannot import `lucide-react`.
So the app registers its own lookup once, in `ui/src/lib/lucide-by-name.tsx`:

```ts
registerBundleRenderer((name) => lucideIcons[pascalLeaf(name)]);
```

Without it a `bundle` tag falls back to fetching its SVG, turning tree-shaken
inline geometry into one HTTP request per glyph.

## Validity, and why a new lucide name needs a command

**A bundle name is valid only if its file is on disk.** The obvious alternative —
let the bundle vouch for every name its library might ship — makes `is_valid`
answer True for `nonexsitent` too, which is the one question the registry exists
to answer.

The served set is kept equal to the used set by
`scripts/build_lucide_icons.py`, which takes no hand-maintained list: it scans
what the codebase emits and cuts the artwork. `--check` is the CI form.

## Adding an icon

1. **A lucide name already served** — just publish it.
2. **A lucide name not yet served** — `uv run python scripts/build_lucide_icons.py`.
3. **New artwork** — drop the SVG under `flow_sdk/server/icons/<pack>/assets/`
   and add an `IconSpec` to that pack's `icon_pack.json`. Set `tintable: false`
   if it has colours of its own.
4. **A new pack** — a directory with an `icon_pack.json`. Nothing registers it;
   the registry globs.

Then run `pytest tests/unit/test_icon_spec.py`. The fence
(`test_every_emitted_name_resolves_exactly`) is what catches the drift this
system was built for — the same Drive source once shipped `GoogleDrive` on one
branch and `HardDrive` on three others.

## What is deliberately NOT in the icon system

- **Static `lucide-react` imports.** 417 files do `import { Check }` and render
  `<Check/>`. That is not a competing resolver — there is nothing to resolve —
  and trading a compile-checked symbol for an unchecked string is a downgrade.
- **`iconForType(type)`** stays as the type→name adapter. CLAUDE.md's
  non-negotiable type-icon rule names it, and it is three lines over the seam.
- **`sourceIcon`** is a name-SELECTION rule (a channel glyph beats the spec's
  default), not a resolver. It ends in the registry.
- **`IconWithBadge`** composes two arbitrary components; `FlowIcon` composes
  tags. Different tools.
- **`FusionSpinner`** is an animation with four hand-drawn frames and its own
  size API, not an icon.

## Seeing it

`examples/icon-gallery/` renders every pack through `FlowIcon` against the app's
own theme tokens — sizes, colours, sub-icons, chips, the collision cases and the
no-React path side by side.

```bash
uv run -m flow_sdk.server.run
cd ui && npx vite --config vite.icon-gallery.config.ts
```
