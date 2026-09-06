"""``IconSpec`` / ``IconPackSpec`` — the icon vocabulary, as a value.

One principle already holds across this codebase: **the backend names the glyph,
the frontend resolves the name.** What was missing is anywhere that says which
names exist. ``TypeInfo.icon`` states the old position outright — *"Free
string by design: the set of valid lucide names lives in the frontend's bundle,
not here"* — and the cost is that a misspelling is invisible until a person looks
at the screen and sees the generic document glyph.

**An icon is named by a dot tag**, in the same grammar as everything else here:
``flow_sdk/tags/grammar.py`` is the single owner of tag string rules, shared by
bus tags, subscription patterns and the kind ontology. A pack declares a parent
``kind`` and each icon a leaf ``kind``; the icon's identity is the join.

    brands.slack            a pack's icon
    brands.claude.restore   a role — one more segment
    lucide.rss              a declared family's member
    icons/my_type.svg       a path; still a location, never a name

**Collisions are not a concept.** Two packs may each declare ``slack``; they are
``brands.slack`` and ``vendorx.slack``, and each is asked for by its full tag.
Nothing needs a precedence rule.

**Resolution is best-match** — the deepest registered ancestor of the tag asked
for. That is exactly ``tag_ancestors``, so no parsing is written here.

Note the two axes, which share a grammar and mean different things:
``spec_kind`` names the SHAPE (``icon``, ``icon.pack``); ``kind`` names the
INSTANCE (``slack``).
"""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.schema.data_spec.spec import DataSpec


class IconSpec(DataSpec):
    """One named glyph. Frozen; a value is a value.

    ``tintable`` is not decoration — it picks the render strategy, and it is what
    makes an icon usable outside React. A tintable glyph is drawn as a CSS mask
    over ``background-color: currentColor``, so it inherits colour from its
    surroundings the way a font does. A multi-colour brand mark cannot: it is an
    ``<img>``, and an ``<img>`` has no way to take the text colour around it.
    """

    spec_kind: ClassVar[str] = "icon"

    #: The leaf segment. The full tag is ``<pack.kind>.<kind>``.
    kind: str
    #: Path to the artwork, relative to the pack's ``base``. Empty for a bundle
    #: pack, whose renderer already holds the geometry.
    asset: str = ""
    #: Mask-render and inherit ``currentColor`` (see the class docstring).
    tintable: bool = True
    #: The default tint for a tintable glyph — ``""`` inherits ``currentColor``.
    #:
    #: This exists because the colour was already being applied, in the wrong
    #: place: ``provider-marks.tsx`` wraps four glyphs purely to add a brand
    #: colour at the call site, and its own docstring calls that a mistake —
    #: *"Colour belongs in the glyph, not at the call site."* A brand that HAS a
    #: colour can now say so once, here, and every surface gets it.
    color: str = ""
    #: Artwork for a dark ground, when the default cannot survive one.
    #:
    #: Not a role a caller may ask for — CSS selects it, because the viewer has
    #: three theme states and only two are legible to JS (an explicit choice
    #: stamps the document; the default "system" setting stamps nothing). Its
    #: own field rather than one key in a bag of roles precisely because it is
    #: the one alternate nobody requests.
    #:
    #: Only meaningful when ``tintable`` is false. A tintable glyph is a mask
    #: painted with ``currentColor`` — it already inverts with the theme, and
    #: masking discards the artwork's own colour, so a dark variant of one is a
    #: contradiction.
    dark: str = ""
    #: Sub-icons: role -> the TAG of a glyph to badge onto this one.
    #:
    #: ``{"restore": "lucide.history"}`` means ``<tag>.restore`` draws this icon
    #: with a small history badge on its corner. The alternative is what the
    #: repo did before — a hand-drawn ``ClaudeRestoreIcon`` per vendor, four
    #: components that differ only in which mark sits under the same arrow, and
    #: which no fifth vendor gets for free.
    #:
    #: A tag, not a path, so the badge resolves through the same registry as
    #: everything else: it can come from another pack, carry its own colour, and
    #: gets the theme handling right without knowing anything about its host.
    #: One level deep — a badge on a badge is a drawing, not an icon.
    sub: dict[str, str] = {}
    #: Other names that mean this icon, as tags.
    #:
    #: The vocabulary is genuinely two vocabularies today — ``TypeInfo`` says
    #: ``ClaudeCode`` where the process tables say ``claude`` and the connection
    #: catalogue says ``anthropic``. Aliasing them is how one registry answers
    #: for all three without a rename. Normalized on load, so a legacy
    #: PascalCase name is a valid single-segment tag by lowercasing.
    aliases: list[str] = []
    #: Where the artwork came from, for the next person who has to re-cut it.
    source: str = ""


class IconPackSpec(DataSpec):
    """A namespace of icons — a declared family, or a carried set.

    ``base`` is stamped by whoever publishes the pack, never by a consumer: the
    files are served by the backend that owns them, and only that backend knows
    its own origin. This is the same reason ``iconAssetUrl`` lives in the SDK and
    not in a component.
    """

    spec_kind: ClassVar[str] = "icon.pack"

    #: Manifest version. Not ``schema`` — that name shadows a ``BaseModel``
    #: attribute and pydantic warns about it.
    version: int = 1
    #: The pack's tag — the parent segment every icon in it hangs off.
    kind: str
    #: URL root the pack's ``asset`` paths hang off. Empty ⇒ the icons are in
    #: the renderer's bundle and there is nothing to fetch.
    base: str = ""
    license: str = ""
    #: Empty ⇒ a declared family the bundle already has (``lucide``).
    icons: list[IconSpec] = []

    @property
    def is_bundle(self) -> bool:
        """A pack that declares a family rather than carrying one."""
        return not self.icons


class IconPackPayload(IconPackSpec):
    """A pack as it travels — the manifest plus what the backend actually serves.

    ``served`` is DERIVED (read off the pack's directory) and must never be
    authorable: a hand-written list is the second copy this whole design exists
    to avoid. But "derived" is not a reason to leave the type system. Patching
    the key into ``model_dump()`` output made the travelling shape something no
    ``DataSpec`` could parse — ``extra="forbid"`` rejected the backend's own
    payload — which is exactly what CLAUDE.md forbids for a shape that travels.

    A subclass keeps both properties: the manifest on disk is an
    ``IconPackSpec`` and cannot carry ``served``, while the wire shape is a
    ``DataSpec`` that round-trips.
    """

    spec_kind: ClassVar[str] = "icon.pack_payload"

    #: Leaf names the pack has artwork for. Only a bundle pack needs it — an
    #: enumerated pack's ``icons`` already say.
    served: list[str] = []


__all__ = ["IconPackPayload", "IconPackSpec", "IconSpec"]
