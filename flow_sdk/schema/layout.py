"""The on-disk SHAPE of an asset type — declared once, asked everywhere.

A type is either a ``File`` (one file, told apart by its extension) or a
``Folder`` (a directory, told apart by the main document it holds).
``locate`` is the per-type half of the SCAN step: given a path, is it this
shape, and if so what is its root, body and asset_ref? The registry-wide half
(``SchemaRegistry.type_for``) asks every declared shape in precedence order.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from flow_sdk._compat import StrEnum


class LayoutKind(StrEnum):
    NONE = "none"            # not this type's shape
    FOLDER = "folder"        # a folder-layout asset named by its folder
    MAIN_FILE = "main_file"  # the inner main file of a folder asset
    FILE = "file"            # a file-layout asset


@dataclass(frozen=True)
class Layout:
    kind: LayoutKind
    root: Path | None      # the asset's storage root (folder or file); None iff NONE
    body: Path | None      # the writable main document, when there is one
    ref: Path | None       # the asset_ref spelling of this asset


NO_LAYOUT = Layout(LayoutKind.NONE, None, None, None)


def _norm_ext(ext: str) -> str:
    return "." + ext.lower().lstrip(".")


@dataclass(frozen=True, slots=True)
class File:
    """A single-file asset told apart by its extension (``.md``, ``.csv``).

    ``also`` lists further extensions the same type accepts (a spreadsheet is
    ``.csv`` or ``.xlsx``); ``ext`` stays the one a create flow writes.
    ``names`` pins a type to FIXED filenames (``CLAUDE.md``): such a file is
    claimed by its name, not by its extension, and no other file of that
    extension is this type.
    """

    ext: str
    also: tuple[str, ...] = ()
    names: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "ext", _norm_ext(self.ext))
        object.__setattr__(self, "also", tuple(_norm_ext(e) for e in self.also))
        object.__setattr__(self, "names", tuple(self.names))

    @property
    def exts(self) -> tuple[str, ...]:
        """Every extension this shape accepts, ``ext`` first."""
        return (self.ext, *self.also)

    def names_file(self, path: Path) -> bool:
        """True when this is a fixed-name shape and ``path`` bears one of its names."""
        return bool(self.names) and path.name.lower() in {n.lower() for n in self.names}

    def locate(self, path: Path, *, verify: bool = False) -> Layout:
        shaped = self.names_file(path) if self.names else path.suffix.lower() in self.exts
        if not shaped or (verify and not path.is_file()):
            return NO_LAYOUT
        return Layout(LayoutKind.FILE, path, path, path)

    def root_of(self, ref: Path) -> Path:
        return ref

    def ref_for(self, root: Path) -> Path:
        return root

    def to_dict(self) -> dict:
        return {"kind": "file", "ext": self.ext, "also": list(self.also), "names": list(self.names)}


@dataclass(frozen=True, slots=True)
class Folder:
    """A directory asset told apart by the main document it holds
    (``SKILL.md``, ``mcp.json``). ``main=None`` is a bare folder asset.
    ``ref_is_main`` ⇒ ``asset_ref`` points at ``<folder>/<main>`` instead of
    the folder (agent, spec, the reports); it changes nothing about locating.
    """

    main: str | None = None
    ref_is_main: bool = False

    def locate(self, path: Path, *, verify: bool = False) -> Layout:
        # Decide by NAME; the one stat keeps a real directory named like the
        # main file a directory. ``verify`` is where existence is required.
        names_main = bool(self.main) and path.name.lower() == self.main.lower()
        if names_main and not path.is_dir():
            root, kind = path.parent, LayoutKind.MAIN_FILE
        else:
            root, kind = path, LayoutKind.FOLDER
            if verify and not (path.is_dir() and self.main and (path / self.main).is_file()):
                return NO_LAYOUT
        body = root / self.main if self.main else None
        return Layout(kind, root, body, self.ref_for(root))

    def root_of(self, ref: Path) -> Path:
        """The folder for either ``asset_ref`` spelling (the folder, or its main)."""
        if self.main and ref.name.lower() == self.main.lower() and not ref.is_dir():
            return ref.parent
        return ref

    def ref_for(self, root: Path) -> Path:
        """Where ``asset_ref`` points for the asset rooted at ``root``."""
        return root / self.main if self.main and self.ref_is_main else root

    def to_dict(self) -> dict:
        return {"kind": "folder", "main": self.main, "ref_is_main": self.ref_is_main}


Shape = File | Folder


def shape_from_dict(data: dict | None) -> Shape | None:
    """Inverse of ``File.to_dict`` / ``Folder.to_dict``; None for no data."""
    if not data:
        return None
    if data.get("kind") == "folder":
        return Folder(main=data.get("main"), ref_is_main=bool(data.get("ref_is_main")))
    return File(ext=data.get("ext") or ".md", also=tuple(data.get("also") or ()), names=tuple(data.get("names") or ()))


@dataclass(frozen=True, slots=True)
class Walk:
    """Where the SCAN looks for assets of a type — declared on the type, so
    the indexer registers one generic walker per declaration instead of a
    hand-written function per type.

    ``roots`` names the root node kinds the walk hangs on (the indexer's root
    graph: ``user_home_folder``, ``real_project_cwd``, ``cwd_root``,
    ``system_root``, ``project``, ``folder``). ``mounts`` are root-relative
    directories to look in (a ``*`` segment is a glob); ``()`` means "derive
    from placement": every harness prefix + family for a harness-scoped class
    (``.claude/skills``, ``.agents/skills``), ``docs`` for the docs family.
    ``recursive`` walks the mount's whole tree instead of its direct children.
    ``anywhere`` (no mounts) is the walk over FOLDER scaffold nodes: a Folder
    shape asks whether the node ITSELF is the asset, a File shape looks at
    the node's direct children.
    """

    roots: tuple[str, ...]
    mounts: tuple[str, ...] = ()
    recursive: bool = False
    anywhere: bool = False

    def __post_init__(self) -> None:
        if self.anywhere and self.mounts:
            raise ValueError("an anywhere walk names no mounts")
