"""``IconSpec`` / ``IconPackSpec`` — the icon vocabulary, as a value.

One principle already holds across this codebase: **the backend names the glyph,
the frontend resolves the name.** What was missing is anywhere that says which
names exist. ``TypeMetadata.icon`` states the old position outright — *"Free
string by design: the set of valid lucide names lives in the frontend's bundle,
not here"* — and the cost is that a misspelling is invisible until a person looks
at the screen and sees the generic document glyph.

A **pack** is a namespace of names. It either *declares a family* the renderer
already has (``lucide`` — thousands of glyphs, zero entries here, because listing
them would be a second copy that drifts) or *carries assets* it enumerates
(``brands``, ``flowpad``). One shape covers both: ``icons`` empty means the
bundle already has them.

Reference grammar, which is all a caller ever writes::

    Rss                     bare — packs in declaration order, i.e. today's behaviour
    brands:slack            qualified
    brands:claude@restore   a variant
    icons/my_type.svg       a path — still works, still resolved last

Theme is deliberately absent from that grammar. A ``dark`` variant is selected by
CSS, not by a caller passing a theme in, because the viewer has three states and
only two of them are legible to JS: an explicit choice stamps the document, and
the default "system" setting stamps nothing at all. CSS can see all three.
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

    #: The name callers write. Unique within the pack.
    name: str
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
    #: Alternate artwork by role — ``"restore"``, ``"dark"``. A role is a name a
    #: caller may ask for (``@restore``) EXCEPT ``dark``, which CSS selects.
    #:
    #: Use this when the role needs artwork of its OWN. When the role is just
    #: this glyph with something small on the corner, use ``sub`` instead —
    #: that composes, and composition does not need a file per pairing.
    variants: dict[str, str] = {}
    #: Sub-icons: role -> the REF of a glyph to badge onto this one.
    #:
    #: ``{"restore": "lucide:history"}`` means ``@restore`` draws this icon with
    #: a small history badge on its corner. The alternative is what the repo did
    #: before — a hand-drawn ``ClaudeRestoreIcon`` per vendor, four components
    #: that differ only in which mark sits under the same arrow, and which no
    #: fifth vendor gets for free.
    #:
    #: A ref, not a path, so the badge resolves through the same registry as
    #: everything else: it can come from another pack, carry its own colour, and
    #: gets the theme handling right without knowing anything about its host.
    #: One level deep — a badge on a badge is a drawing, not an icon.
    sub: dict[str, str] = {}
    #: Other names that mean this icon. The vocabulary is genuinely two
    #: vocabularies today — ``TypeInfo`` says ``ClaudeCode`` where the process
    #: tables say ``claude`` and the connection catalogue says ``anthropic`` —
    #: and every one of those is in shipped data. Aliasing them is how one
    #: registry can answer for all three without a rename.
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
    name: str
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


__all__ = ["IconPackSpec", "IconSpec"]
