"""Loading and resolving icon packs.

This is the first thing on the Python side that can answer "is this a real icon
name?". Until now nothing could: ``TypeMetadata.icon`` is a free string whose
docstring says outright that the valid set "lives in the frontend's bundle, not
here", so a typo was invisible until someone looked at a screen and saw the
generic document glyph.

**Icons are named by dot tags and resolution is best-match** — the deepest
registered ancestor of the tag asked for. ``brands.claude.restore`` resolves to
itself when that role exists and to ``brands.claude`` when it does not, because
an icon is decoration and a base glyph beats nothing. The walk is
``tag_ancestors`` from ``flow_sdk/tags/grammar.py``, the single owner of tag
string rules; nothing here parses a tag by hand.

**Best-match at runtime, exact-match in the fence.** Degrading is right in front
of a person, but it means a misspelled leaf on a valid path
(``brands.slack.typo``) would silently succeed. So a resolution reports the tag
it ACTUALLY matched, and the fence test asserts asked == matched for every name
the codebase emits. Graceful where someone is looking; strict where CI is.

**A bundle pack derives its asset path rather than listing one.** ``lucide``
carries thousands of glyphs; enumerating them here would be a second copy that
drifts out of step with the package. Instead the pack declares a ``base`` and
the asset is ``<leaf>.svg`` under it. That keeps the manifest four lines long
and still gives a non-React consumer a URL to fetch, which is what makes the
plain-HTML path possible.

**A bundle name is only valid if its file is on disk**, and that is deliberate.
The obvious alternative — let the bundle vouch for every name its library might
ship — makes ``is_valid`` answer True for ``nonexsitent`` too, which is the one
question the registry exists to answer. Grounding validity in the served files
costs a new lucide name one run of ``scripts/build_lucide_icons.py``, and buys
two things: a typo is caught in Python, and the plain-HTML path can never 404.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Optional

from flow_sdk.schema.data_spec.icon_spec import IconPackPayload, IconPackSpec, IconSpec
from flow_sdk.tags.grammar import normalize_tag, tag_ancestors

#: The one manifest filename a pack directory is recognised by.
MANIFEST = "icon_pack.json"

_KEBAB = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])")


def kebab(name: str) -> str:
    """``BarChart3`` -> ``bar-chart-3`` — lucide's own file-slug convention.

    Runs BEFORE normalization, and that order matters: normalizing first
    lowercases ``BarChart3`` to ``barchart3`` and the word boundaries the slug
    needs are gone.
    """
    return _KEBAB.sub("-", name).lower()


def icon_tag(value: str) -> str:
    """A caller's string as a tag. Kebab first (see ``kebab``), then the
    grammar's own strict gate. Raises on anything that is not a legal tag."""
    return normalize_tag(kebab(value))


@dataclass(frozen=True)
class IconResolution:
    """What a reference resolved to.

    ``asked`` and ``tag`` differ exactly when best-match degraded the request —
    which is the signal a caller (or the fence) needs to tell "this role does not
    exist, here is the base glyph" from "this is what you asked for".
    """

    #: The pack that answered.
    pack: str
    spec: IconSpec
    #: The icon's CANONICAL full tag — ``brands.claude``, or
    #: ``brands.claude.restore`` for a role. Always the identity, never the
    #: alias or bare name that happened to be asked for, so two call sites
    #: spelling the same icon differently report the same thing.
    tag: str
    #: What the caller actually passed, normalized.
    asked: str
    #: True when best-match walked UP to answer — the requested role does not
    #: exist and this is an ancestor. Not the same as ``asked != tag``: a bare
    #: ``Rss`` resolving to ``lucide.rss`` is a lookup, not a downgrade.
    degraded: bool = False
    #: ``icons/brands/assets/slack.svg``. Empty only for a bundle pack with no base.
    asset_path: str = ""
    #: The TAG of a sub-icon to badge onto this one, when the matched role is
    #: composed rather than drawn (see ``IconSpec.sub``). The caller resolves it
    #: the same way as any other tag — one level, no recursion.
    sub_tag: str = ""

    @property
    def exact(self) -> bool:
        """True when the caller got the role it asked for."""
        return not self.degraded


class IconRegistry:
    """Every pack this backend serves, indexed by full tag."""

    def __init__(self, root: Optional[Path] = None) -> None:
        self._root = root or (Path(__file__).resolve().parent.parent / "server" / "icons")

    @cached_property
    def packs(self) -> list[IconPackSpec]:
        """Packs, sorted by kind. Order is presentation only — it no longer
        decides anything, because a full tag names exactly one icon."""
        found: dict[str, IconPackSpec] = {}
        if self._root.is_dir():
            for manifest in sorted(self._root.glob(f"*/{MANIFEST}")):
                spec = IconPackSpec(**json.loads(manifest.read_text()))
                found[spec.kind] = spec
        return sorted(found.values(), key=lambda p: p.kind)

    @cached_property
    def _by_tag(self) -> dict[str, tuple[IconPackSpec, IconSpec, str]]:
        """full tag -> (pack, spec, role).

        Every addressable tag lives here: an icon's own tag, each alias, and one
        entry per declared role so ``brands.claude.restore`` is a key rather
        than a special case in the lookup.
        """
        index: dict[str, tuple[IconPackSpec, IconSpec, str]] = {}
        for pack in self.packs:
            for spec in pack.icons:
                tags = [f"{pack.kind}.{spec.kind}"]
                tags += [icon_tag(alias) for alias in spec.aliases]
                for tag in tags:
                    index.setdefault(tag, (pack, spec, ""))
                    for role in (*spec.sub, *( ["dark"] if spec.dark else [] )):
                        if role == "dark":
                            continue  # CSS selects it; never addressable
                        index.setdefault(f"{tag}.{role}", (pack, spec, role))
        return index

    @cached_property
    def _by_kind(self) -> dict[str, IconPackSpec]:
        return {p.kind: p for p in self.packs}

    @cached_property
    def _served(self) -> dict[str, frozenset[str]]:
        """pack -> the slugs it ships, read once.

        Every bundle-name lookup asks this, and the bootstrap payload asks it
        again per request. Statting per lookup made a screenful of icons a
        screenful of syscalls; the files ship in the wheel and cannot change
        under a running process, so one read each is the whole cost."""
        return {p.kind: frozenset(self.served(p)) for p in self.packs}

    def _file(self, asset_path: str) -> Path:
        """The on-disk file behind an ``icons/<pack>/...`` path."""
        return self._root.parent / asset_path

    def served(self, pack: IconPackSpec) -> list[str]:
        """The leaf names a pack has artwork for, derived from its directory.

        For a bundle pack this is the whole vocabulary — never the manifest,
        which is the point of a declared family. It is published so a client can
        list what is available without a directory index (which the static mount
        does not serve) and without a second copy of the list in the manifest.
        """
        if not pack.base:
            return []
        directory = self._file(pack.base)
        if not directory.is_dir():
            return []
        return sorted(p.stem for p in directory.glob("*.svg"))

    def _asset(self, pack: IconPackSpec, asset: str) -> str:
        return f"{pack.base.rstrip('/')}/{asset}" if pack.base and asset else asset

    def _resolve_tag(self, key: str, asked: str, degraded: bool) -> Optional[IconResolution]:
        """One addressable key to a resolution, or ``None`` if nothing claims it.

        ``key`` is whatever was looked up — a canonical tag, an alias, or a bare
        legacy name. What comes back always carries the CANONICAL tag."""
        hit = self._by_tag.get(key)
        if hit is not None:
            pack, spec, role = hit
            canonical = f"{pack.kind}.{spec.kind}" + (f".{role}" if role else "")
            return IconResolution(
                pack=pack.kind,
                spec=spec,
                tag=canonical,
                asked=asked,
                degraded=degraded,
                asset_path=self._asset(pack, spec.asset),
                sub_tag=spec.sub.get(role, "") if role else "",
            )
        # A bundle pack answers for a leaf it does not list, if it serves it.
        head, _, leaf = key.rpartition(".")
        pack = self._by_kind.get(head)
        if pack is not None and pack.is_bundle and leaf in self._served.get(pack.kind, frozenset()):
            spec = IconSpec(kind=leaf)
            return IconResolution(
                pack=pack.kind,
                spec=spec,
                tag=f"{pack.kind}.{leaf}",
                asked=asked,
                degraded=degraded,
                asset_path=self._asset(pack, f"{leaf}.svg"),
            )
        return None

    def resolve(self, ref: str) -> Optional[IconResolution]:
        """A reference to what it names, best-match, or ``None``.

        A path (anything containing ``/``) is deliberately NOT resolved here: it
        is already a location, and ``iconAssetUrl`` in the TS SDK is the one
        place that turns a path into a URL. Returning ``None`` says "not a tag",
        which is exactly what the caller needs to know.
        """
        if not ref or "/" in ref:
            return None
        try:
            asked = icon_tag(ref)
        except (TypeError, ValueError):
            return None

        # Deepest registered ancestor wins; `tag_ancestors` runs broadest-first.
        chain = list(reversed(tag_ancestors(asked, include_self=True)))
        for depth, key in enumerate(chain):
            found = self._resolve_tag(key, asked, degraded=depth > 0)
            if found is not None:
                return found

        # A bare leaf naming no pack — legacy `Rss`, `Slack`. Arbitrary by
        # definition: whichever pack answers first, in pack order. Not a
        # degradation; the caller asked by name and got that name's icon.
        if "." not in asked:
            for pack in self.packs:
                found = self._resolve_tag(f"{pack.kind}.{asked}", asked, degraded=False)
                if found is not None:
                    return found
        return None

    def is_valid(self, ref: str) -> bool:
        """True when ``ref`` names something this backend can serve.

        A path is valid by construction (it is a location, not a name), so it
        answers True without a lookup. Best-match means this is deliberately
        lenient about a bad ROLE on a good icon; the fence tests exactness.
        """
        if ref and "/" in ref:
            return True
        return self.resolve(ref) is not None

    def missing_assets(self) -> list[str]:
        """Manifest entries whose artwork is absent — a packaging bug, and the
        thing a test should fail on. Bundle packs derive their paths and so
        cannot appear here."""
        gone: list[str] = []
        for pack in self.packs:
            for spec in pack.icons:
                for asset in (spec.asset, spec.dark):
                    if asset and not self._file(self._asset(pack, asset)).is_file():
                        gone.append(f"{pack.kind}.{spec.kind} -> {self._asset(pack, asset)}")
        return gone

    def payload(self) -> list[dict]:
        """The packs as they travel, for bootstrap and the ``icons`` action.

        Built through ``IconPackPayload`` rather than by patching a key into
        ``model_dump()`` output: a shape that travels IS a ``DataSpec``, so the
        payload a client receives is one the backend can parse back."""
        return [
            IconPackPayload(
                **pack.model_dump(),
                served=sorted(self._served.get(pack.kind, frozenset())) if pack.is_bundle else [],
            ).model_dump(mode="json")
            for pack in self.packs
        ]


#: The process-wide registry.
icons = IconRegistry()

__all__ = ["IconRegistry", "IconResolution", "icon_tag", "icons", "kebab"]
