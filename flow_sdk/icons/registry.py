"""Loading and resolving icon packs.

This is the first thing on the Python side that can answer "is this a real icon
name?". Until now nothing could: ``TypeMetadata.icon`` is a free string whose
docstring says outright that the valid set "lives in the frontend's bundle, not
here", so a typo was invisible until someone looked at a screen and saw the
generic document glyph.

**Pack order is resolution order, and it matches what the frontend already
does.** ``lucideByName`` checks its bespoke ``CUSTOM_ICONS`` table before it
looks at lucide's exports, so a name we define wins over a name lucide happens
to ship. ``PACK_ORDER`` below preserves exactly that: brands, then flowpad, then
lucide.

**A bundle pack derives its asset path rather than listing one.** ``lucide``
carries thousands of glyphs; enumerating them here would be a second copy that
drifts out of step with the package. Instead the pack declares a ``base`` and
the asset is ``kebab(name).svg`` under it — the same slug lucide names its own
files by. That keeps the manifest four lines long and still gives a non-React
consumer a URL to fetch, which is what makes the plain-HTML path possible.

**A bundle name is only valid if its file is on disk**, and that is deliberate.
The obvious alternative — let the bundle vouch for every name its library might
ship — makes ``is_valid`` answer True for ``Nonexsitent`` too, which is the one
question the registry exists to answer. Grounding validity in the served files
costs a new lucide name one run of ``scripts/build_lucide_icons.py``, and buys
two things: a typo is caught in Python, and the plain-HTML path can never 404.
The served set and the used set stay in lockstep by construction.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Optional

from flow_sdk.schema.data_spec.icon_spec import IconPackSpec, IconSpec

#: Earlier packs win a bare name — see the module docstring.
PACK_ORDER = ("brands", "flowpad", "lucide")

#: The one manifest filename a pack directory is recognised by.
MANIFEST = "icon_pack.json"

_KEBAB = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])")


def kebab(name: str) -> str:
    """``BarChart3`` -> ``bar-chart-3`` — lucide's own file-slug convention."""
    return _KEBAB.sub("-", name).lower()


@dataclass(frozen=True)
class IconResolution:
    """What a reference resolved to. ``asset_path`` is relative to the backend
    origin; the caller (or the TS SDK) absolutises it."""

    pack: str
    spec: IconSpec
    #: The variant that was asked for, if any — ``"restore"``.
    variant: str = ""
    #: ``icons/brands/assets/slack.svg``. Empty only for a bundle pack with no base.
    asset_path: str = ""
    #: The REF of a sub-icon to badge onto this one, when the requested role is
    #: composed rather than drawn (see ``IconSpec.sub``). The caller resolves it
    #: the same way as any other ref — one level, no recursion.
    sub_ref: str = ""


class IconRegistry:
    """Every pack this backend serves, indexed by name and alias."""

    def __init__(self, root: Optional[Path] = None) -> None:
        self._root = root or (Path(__file__).resolve().parent.parent / "server" / "icons")

    @cached_property
    def packs(self) -> list[IconPackSpec]:
        """Packs in resolution order. A directory that is not in ``PACK_ORDER``
        still loads — it simply sorts after the ones that are, so a plugin can
        drop a pack in without editing this file."""
        found: dict[str, IconPackSpec] = {}
        if self._root.is_dir():
            for manifest in sorted(self._root.glob(f"*/{MANIFEST}")):
                spec = IconPackSpec(**json.loads(manifest.read_text()))
                found[spec.name] = spec
        order = {n: i for i, n in enumerate(PACK_ORDER)}
        return sorted(found.values(), key=lambda p: (order.get(p.name, len(order)), p.name))

    @cached_property
    def _index(self) -> dict[str, tuple[str, IconSpec]]:
        """name-or-alias -> (pack, spec), first pack in order wins.

        A name may legitimately exist in more than one pack. Only the winner is
        kept: the losers are still reachable by qualifying the reference, so
        carrying them here would be a list nothing ever reads past ``[0]``."""
        idx: dict[str, tuple[str, IconSpec]] = {}
        for pack in self.packs:
            for spec in pack.icons:
                for key in (spec.name, *spec.aliases):
                    idx.setdefault(key, (pack.name, spec))
        return idx

    @cached_property
    def _by_pack(self) -> dict[str, IconPackSpec]:
        return {p.name: p for p in self.packs}

    def _asset_path(self, pack: IconPackSpec, spec: IconSpec, variant: str) -> str:
        asset = spec.variants.get(variant, "") if variant else spec.asset
        if not asset and not variant:
            # A bundle pack lists nothing; derive the slug (see module docstring).
            asset = f"{kebab(spec.name)}.svg" if pack.base else ""
        if not asset:
            return ""
        return f"{pack.base.rstrip('/')}/{asset}" if pack.base else asset

    def _file(self, asset_path: str) -> Path:
        """The on-disk file behind an ``icons/<pack>/...`` path."""
        return self._root.parent / asset_path

    @cached_property
    def _served(self) -> dict[str, frozenset[str]]:
        """pack -> the slugs it ships, read once.

        Every bundle-name lookup asks this, and the bootstrap payload asks it
        again per request. Statting per lookup made a screenful of icons a
        screenful of syscalls; the files ship in the wheel and cannot change
        under a running process, so one read each is the whole cost."""
        return {p.name: frozenset(self.served(p)) for p in self.packs}

    def _serves(self, pack: IconPackSpec, name: str) -> bool:
        """Does this bundle pack actually ship artwork for ``name``?"""
        return bool(pack.base) and kebab(name) in self._served.get(pack.name, frozenset())

    def missing_assets(self) -> list[str]:
        """Manifest entries whose artwork is absent — a packaging bug, and the
        thing a test should fail on. Bundle packs derive their paths and so
        cannot appear here."""
        gone: list[str] = []
        for pack in self.packs:
            for spec in pack.icons:
                for asset in (spec.asset, *spec.variants.values()):
                    if not asset:
                        continue
                    path = f"{pack.base.rstrip('/')}/{asset}" if pack.base else asset
                    if not self._file(path).is_file():
                        gone.append(f"{pack.name}:{spec.name} -> {path}")
        return gone

    def _resolution(self, pack: IconPackSpec, spec: IconSpec, variant: str) -> IconResolution:
        """Build a resolution, choosing baked artwork over composition.

        A role declared BOTH ways is not an error — the baked file is the
        vendor's own drawing and beats a generic badge, so it wins and the
        composition is simply unused."""
        if variant and variant not in spec.variants and variant in spec.sub:
            # Composed: the base artwork, plus a sub-icon the caller resolves.
            return IconResolution(
                pack.name, spec, variant, self._asset_path(pack, spec, ""), spec.sub[variant]
            )
        return IconResolution(pack.name, spec, variant, self._asset_path(pack, spec, variant))

    def resolve(self, ref: str) -> Optional[IconResolution]:
        """A reference to what it names, or ``None``.

        A path (anything containing ``/``) is deliberately NOT resolved here: it
        is already a location, and ``iconAssetUrl`` in the TS SDK is the one
        place that turns a path into a URL. Returning ``None`` says "not a pack
        name", which is exactly what the caller needs to know.
        """
        ref = (ref or "").strip()
        if not ref or "/" in ref:
            return None

        variant = ""
        if "@" in ref:
            ref, _, variant = ref.partition("@")

        if ":" in ref:
            pack_name, _, name = ref.partition(":")
            pack = self._by_pack.get(pack_name)
            if pack is None:
                return None
            spec = next(
                (s for s in pack.icons if s.name == name or name in s.aliases),
                None,
            )
            if spec is None:
                # A bundle pack vouches for a name only if it actually serves it.
                if not pack.is_bundle or not self._serves(pack, name):
                    return None
                spec = IconSpec(name=name)
            # `and spec.variants` would short-circuit here and let an icon with
            # NO variants answer for any role, handing back an empty asset.
            if variant and variant not in spec.variants and variant not in spec.sub:
                return None
            return self._resolution(pack, spec, variant)

        hit = self._index.get(ref)
        if hit:
            pack_name, spec = hit
            if variant and variant not in spec.variants and variant not in spec.sub:
                return None
            return self._resolution(self._by_pack[pack_name], spec, variant)

        # Unqualified and unlisted: a bundle pack answers for it if it serves it.
        for pack in self.packs:
            if pack.is_bundle and not variant and self._serves(pack, ref):
                spec = IconSpec(name=ref)
                return IconResolution(pack.name, spec, "", self._asset_path(pack, spec, ""))
        return None

    def is_valid(self, ref: str) -> bool:
        """True when ``ref`` names something this backend can serve.

        A path is valid by construction (it is a location, not a name), so it
        answers True without a lookup.
        """
        if ref and "/" in ref:
            return True
        return self.resolve(ref) is not None

    def served(self, pack: IconPackSpec) -> list[str]:
        """The names a pack actually has artwork for.

        For a bundle pack this is derived from the directory, never from the
        manifest — that is the whole point of a declared family. It is published
        so a client can list what is available without a directory index (which
        the static mount does not serve) and without a second copy of the list
        living in the manifest."""
        if not pack.base:
            return []
        directory = self._file(pack.base)
        if not directory.is_dir():
            return []
        return sorted(p.stem for p in directory.glob("*.svg"))

    def payload(self) -> list[dict]:
        """The packs as plain dicts, for bootstrap and the ``icons`` action.

        A bundle pack carries a derived ``served`` list so a client knows what it
        can ask for. An enumerated pack does not need one — its ``icons`` already
        say.

        This is a WIRE shape, not a manifest: ``served`` is derived here and is
        deliberately not an ``IconPackSpec`` field, because a field would be
        authorable and a hand-written list is the second copy this whole design
        avoids. The consequence is that a blob from here does not round-trip
        through ``IconPackSpec(**blob)`` — ``extra="forbid"`` rejects it. Read a
        pack from disk to get a spec; read this to get what a client renders."""
        out = []
        for pack in self.packs:
            blob = pack.model_dump(mode="json")
            if pack.is_bundle:
                blob["served"] = sorted(self._served.get(pack.name, frozenset()))
            out.append(blob)
        return out


#: The process-wide registry.
icons = IconRegistry()

__all__ = ["IconRegistry", "IconResolution", "PACK_ORDER", "icons", "kebab"]
