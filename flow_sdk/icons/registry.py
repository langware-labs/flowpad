"""Loading and resolving icon packs.

This is the first thing on the Python side that can answer "is this a real icon
name?". Until now nothing could: ``TypeInfo.icon`` is a free string whose
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

**A pack can also be an ASSET** -- ``<scope>/agentic-assets/icon_pack/<name>/``
(``icon_pack.json`` + its SVGs), in any project, the user asset root, the shipped
assistant project, or a received asset. Indexing one registers it here
(``add_asset_pack``), the way indexing a data schema registers its kind; the
bootstrap re-reads the indexed rows (``sync_indexed``) so a restart loses
nothing. Its files are served under ``/icon-packs/<kind>/`` (``ASSET_PACK_ROUTE``)
and its ``base`` says so, so the frontend resolves it like any other pack.

**Two packs with one kind is an error, never a precedence.** Both are named in
the problem and neither asset pack is served; a built-in pack keeps its kind.
An asset pack is validated before anything of it is served: the manifest
parses, its tags are legal, every asset exists inside the folder, and every SVG
is inert (``svg_problems``). A failing icon is dropped and reported; the rest of
the pack still serves.
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Iterable, Optional
from xml.etree import ElementTree

from pydantic import ValidationError

from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR
from flow_sdk.schema.data_spec.icon_spec import IconPackDocSpec, IconPackPayload, IconPackSpec, IconSpec
from flow_sdk.schema.data_spec.spec import validation_summary
from flow_sdk.tags.grammar import normalize_tag, tag_ancestors

#: The one manifest filename a pack directory is recognised by.
MANIFEST = "icon_pack.json"
#: The asset family -- ``<scope>/agentic-assets/icon_pack/<name>/``.
FAMILY = "icon_pack"
#: The URL prefix an asset pack's files are served under: ``/icon-packs/<kind>/<asset>``.
ASSET_PACK_ROUTE = "icon-packs"

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


#: Elements that make an SVG active rather than a picture.
_UNSAFE_ELEMENTS = frozenset({"script", "foreignobject", "iframe", "embed", "object", "handler", "listener"})


def svg_problems(path: Path) -> list[str]:
    """Why an SVG is not safe to serve as an icon; ``[]`` when it is inert.

    An icon is a picture: no script, no event handler, nothing fetched from
    elsewhere. A DOCTYPE is refused outright -- it is how entities get in -- and
    a document that does not parse is a problem, not a crash of whoever indexes it.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [f"{path.name}: unreadable ({exc})"]
    if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
        return [f"{path.name}: a DOCTYPE/ENTITY declaration is not allowed"]
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as exc:
        return [f"{path.name}: not well-formed XML ({exc})"]
    if root.tag.rpartition("}")[2].lower() != "svg":
        return [f"{path.name}: root element is not <svg>"]
    problems: list[str] = []
    for el in root.iter():
        name = el.tag.rpartition("}")[2].lower() if isinstance(el.tag, str) else ""
        if name in _UNSAFE_ELEMENTS:
            problems.append(f"{path.name}: <{name}> is not allowed")
        for attr, value in el.attrib.items():
            local = attr.rpartition("}")[2].lower()
            if local.startswith("on"):
                problems.append(f"{path.name}: event handler {local!r} is not allowed")
            elif local == "href" and not value.strip().startswith("#"):
                problems.append(f"{path.name}: external reference {value!r} is not allowed")
            elif "url(" in value.replace(" ", "").lower() and "url(#" not in value.replace(" ", "").lower():
                problems.append(f"{path.name}: external url() in {local!r} is not allowed")
    return problems


@dataclass(frozen=True)
class AssetPack:
    """An ``icon_pack`` asset folder as read and checked.

    ``spec`` is what is served (``None`` when the manifest itself is unusable),
    already stamped with its served ``base`` and holding only the icons that
    passed; ``problems`` is everything that did not.
    """

    folder: Path
    spec: Optional[IconPackSpec]
    problems: tuple[str, ...] = ()


def read_asset_pack(folder: Path) -> AssetPack:
    """Read and validate one icon pack asset folder. Never raises."""
    folder = Path(folder)
    manifest = folder / MANIFEST
    try:
        raw = json.loads(manifest.read_text(encoding="utf-8"))
        doc = IconPackDocSpec.model_validate(raw)
    except OSError as exc:
        return AssetPack(folder, None, (f"{MANIFEST}: unreadable ({exc})",))
    except ValueError as exc:  # JSONDecodeError and ValidationError both
        detail = validation_summary(exc) if isinstance(exc, ValidationError) else str(exc)
        return AssetPack(folder, None, (f"{MANIFEST}: {detail}",))
    try:
        kind = normalize_tag(doc.kind)
    except (TypeError, ValueError) as exc:
        return AssetPack(folder, None, (f"pack kind {doc.kind!r} is not a legal tag ({exc})",))

    problems: list[str] = []
    kept: list[IconSpec] = []
    root = folder.resolve()
    for spec in doc.icons:
        mine: list[str] = []
        label = f"{kind}.{spec.kind}"
        try:
            if normalize_tag(spec.kind) != spec.kind or "." in spec.kind:
                mine.append(f"{label}: icon kind must be one lowercase tag segment")
            for alias in spec.aliases:
                icon_tag(alias)
            for role, ref in spec.sub.items():
                normalize_tag(role)
                normalize_tag(ref)
        except (TypeError, ValueError) as exc:
            mine.append(f"{label}: illegal tag ({exc})")
        if not spec.asset:
            mine.append(f"{label}: no asset file")
        for asset in (spec.asset, spec.dark):
            if not asset:
                continue
            path = (folder / asset).resolve()
            if not path.is_relative_to(root):
                mine.append(f"{label}: asset {asset!r} is outside the pack folder")
            elif not path.is_file():
                mine.append(f"{label}: asset file {asset!r} does not exist")
            elif path.suffix.lower() != ".svg":
                mine.append(f"{label}: asset {asset!r} is not an .svg")
            else:
                mine.extend(f"{label}: {p}" for p in svg_problems(path))
        if mine:
            problems.extend(mine)
        else:
            kept.append(spec)
    if not doc.icons:
        problems.append("the pack declares no icons")
    spec = IconPackSpec(
        version=doc.version, kind=kind, base=f"{ASSET_PACK_ROUTE}/{kind}", license=doc.license, icons=kept,
    )
    return AssetPack(folder, spec if kept else None, tuple(problems))


def asset_pack_folders(root: Path) -> list[Path]:
    """Every ``icon_pack`` folder of one scope root (``<root>/agentic-assets/icon_pack/*``)."""
    base = Path(root) / AGENTIC_ASSETS_DIR / FAMILY
    if not base.is_dir():
        return []
    return sorted(p.parent for p in base.glob(f"*/{MANIFEST}"))


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

    def __init__(self, root: Optional[Path] = None, *, discover_shipped: bool = True) -> None:
        self._root = root or (Path(__file__).resolve().parent.parent / "server" / "icons")
        self._lock = threading.RLock()
        #: Asset pack folders this process knows, -> what reading them found.
        self._assets: dict[Path, AssetPack] = {}
        self._discover_shipped = discover_shipped

    _DERIVED = ("packs", "_by_tag", "_by_kind", "_served", "_accepted")

    def _invalidate(self) -> None:
        for name in self._DERIVED:
            self.__dict__.pop(name, None)

    @cached_property
    def _builtin(self) -> list[IconPackSpec]:
        found: dict[str, IconPackSpec] = {}
        if self._root.is_dir():
            for manifest in sorted(self._root.glob(f"*/{MANIFEST}")):
                spec = IconPackSpec(**json.loads(manifest.read_text()))
                found[spec.kind] = spec
        return list(found.values())

    def _ensure_shipped(self) -> None:
        """The assistant project's own packs -- read once, on first use."""
        if not self._discover_shipped:
            return
        self._discover_shipped = False
        try:
            from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415

            for folder in asset_pack_folders(flowpad_assistant_project_root()):
                self._assets.setdefault(folder.resolve(), read_asset_pack(folder))
        except Exception:  # noqa: BLE001 -- a broken shipped tree must not take icons down
            pass

    # ── asset packs ────────────────────────────────────────────────────────

    def add_asset_pack(self, folder: Path) -> list[str]:
        """Register (or re-read) one icon pack asset folder; its problems, ``[]`` when clean.

        Indexing calls this, so "indexed" and "served" are one event."""
        folder = Path(folder).resolve()
        with self._lock:
            self._ensure_shipped()
            self._assets[folder] = read_asset_pack(folder)
            self._invalidate()
        return self.problems(folder)

    def remove_asset_pack(self, folder: Path) -> None:
        with self._lock:
            if self._assets.pop(Path(folder).resolve(), None) is not None:
                self._invalidate()

    def add_scope(self, root: Path) -> None:
        """Register every pack of one scope root not registered yet (a chart's project)."""
        for folder in asset_pack_folders(root):
            if folder.resolve() not in self._assets:
                self.add_asset_pack(folder)

    def add_near(self, path: Path) -> None:
        """Register the packs of every scope above ``path`` -- what a docs chart can see."""
        for parent in (Path(path), *Path(path).parents):
            if (parent / AGENTIC_ASSETS_DIR / FAMILY).is_dir():
                self.add_scope(parent)

    async def sync_indexed(self) -> None:
        """Register every INDEXED icon pack asset (any scope, received ones included).

        Folders that are gone from disk drop out; nothing indexed is re-read
        unless it is new to this process."""
        try:
            from flow_sdk.builtin.icon_pack import IconPack  # noqa: PLC0415

            rows = await IconPack.get_all() or []
        except Exception:  # noqa: BLE001 -- no store (a bare CLI): the shipped packs still serve
            return
        for row in rows:
            ref = getattr(row, "asset_ref", "") or ""
            if not ref:
                continue
            folder = Path(ref)
            folder = folder.parent if folder.name == MANIFEST else folder
            if (folder / MANIFEST).is_file() and folder.resolve() not in self._assets:
                self.add_asset_pack(folder)

    @cached_property
    def _accepted(self) -> tuple[dict[str, AssetPack], dict[Path, list[str]]]:
        """(kind -> the asset pack serving it, folder -> collision problems)."""
        self._ensure_shipped()
        builtin = {p.kind for p in self._builtin}
        by_kind: dict[str, list[AssetPack]] = {}
        for pack in self._assets.values():
            if pack.spec is not None:
                by_kind.setdefault(pack.spec.kind, []).append(pack)
        served: dict[str, AssetPack] = {}
        clashes: dict[Path, list[str]] = {}
        for kind, claimants in by_kind.items():
            if kind in builtin or len(claimants) > 1:
                names = ([f"the built-in {kind!r} pack"] if kind in builtin else []) + [
                    str(p.folder) for p in claimants
                ]
                for pack in claimants:
                    clashes[pack.folder] = [f"icon pack kind {kind!r} is declared by both " + " and ".join(names)]
            else:
                served[kind] = claimants[0]
        return served, clashes

    def problems(self, folder: Path) -> list[str]:
        """Everything wrong with one registered asset pack: its own checks, then collisions."""
        folder = Path(folder).resolve()
        pack = self._assets.get(folder)
        if pack is None:
            return []
        return [*pack.problems, *self._accepted[1].get(folder, [])]

    def asset_pack(self, folder: Path) -> Optional[AssetPack]:
        """What reading one registered asset pack folder found."""
        return self._assets.get(Path(folder).resolve())

    def asset_folder(self, kind: str) -> Optional[Path]:
        """The folder serving asset pack ``kind`` -- what ``/icon-packs/<kind>/`` reads."""
        pack = self._accepted[0].get(kind)
        return pack.folder if pack is not None else None

    def served_file(self, kind: str, asset: str) -> Optional[Path]:
        """The file behind ``/icon-packs/<kind>/<asset>`` -- only an asset a
        VALIDATED icon of a served pack names; ``None`` for anything else."""
        pack = self._accepted[0].get(kind)
        if pack is None or pack.spec is None:
            return None
        if not any(asset in (spec.asset, spec.dark) for spec in pack.spec.icons):
            return None
        path = (pack.folder / asset).resolve()
        return path if path.is_relative_to(pack.folder.resolve()) and path.is_file() else None

    @cached_property
    def packs(self) -> list[IconPackSpec]:
        """Packs, sorted by kind. Order is presentation only — it no longer
        decides anything, because a full tag names exactly one icon."""
        found = {p.kind: p for p in self._builtin}
        for kind, pack in self._accepted[0].items():
            found[kind] = pack.spec
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
        """The on-disk file behind an ``icons/<pack>/...`` or ``icon-packs/<kind>/...`` path."""
        head, _, rest = asset_path.partition("/")
        if head == ASSET_PACK_ROUTE:
            kind, _, inner = rest.partition("/")
            folder = self.asset_folder(kind)
            if folder is not None:
                return folder / inner
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

def icon_ref_problem(ref: object, registry: Optional[IconRegistry] = None) -> Optional[str]:
    """Why an icon reference (a chart participant's ``icon``) will not resolve, or ``None``.

    A path is a location and an emoji is the glyph itself -- neither is a name to
    check. A tag must resolve EXACTLY: best-match degrading to an ancestor is a
    typo at authoring time."""
    if not isinstance(ref, str) or not ref.strip() or "/" in ref:
        return None
    try:
        icon_tag(ref)
    except (TypeError, ValueError):
        return None
    found = (registry or icons).resolve(ref)
    if found is None:
        return f"icon {ref!r} does not resolve to any icon pack"
    if found.degraded:
        return f"icon {ref!r} does not exist; the closest is {found.tag!r}"
    return None


def check_tags(refs: Iterable[str], registry: Optional[IconRegistry] = None) -> dict[str, Optional[str]]:
    """``{ref: problem or None}`` for each reference -- the ``flow icons check`` answer."""
    return {ref: icon_ref_problem(ref, registry) for ref in refs}


__all__ = [
    "ASSET_PACK_ROUTE", "AssetPack", "IconRegistry", "IconResolution", "asset_pack_folders", "check_tags",
    "icon_ref_problem", "icon_tag", "icons", "kebab", "read_asset_pack", "svg_problems",
]
