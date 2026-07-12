"""Path normalization for asset_ref storage and folder-prefix queries.

`canonical_posix_path` is the single rule the entity DB uses to canonicalize
asset paths so that the lex-range trick used by `Entity.assets_by_path`
matches stored values across macOS, Linux, and Windows on the same host.
"""

from __future__ import annotations

import unicodedata
from pathlib import Path


def canonical_posix_path(p: Path | str) -> str:
    """Canonical POSIX form of a filesystem path.

    - ``Path.resolve()`` follows symlinks and returns the FS-canonical case
      on macOS APFS and Windows NTFS (case-insensitive but case-preserving).
    - ``as_posix()`` collapses ``\\`` vs ``/`` so Windows paths sort like
      ``C:/Users/foo`` and the half-open range trick works.
    - ``unicodedata.normalize("NFC", ...)`` defuses macOS APFS NFD vs NFC
      pitfalls; no-op for ASCII paths.
    """
    return unicodedata.normalize("NFC", Path(p).resolve().as_posix())


def ancestors_of(p: Path | str) -> list[str]:
    """Ancestor directories of ``p`` in canonical posix form, deepest first,
    excluding the filesystem root.

    Canonicalizes through ``canonical_posix_path`` first so the returned keys
    match stored ``asset_ref`` values (which are written through the same
    rule) — the containment counterpart of ``is_path_under``.
    """
    from pathlib import PurePosixPath

    canon = canonical_posix_path(p)
    return [a.as_posix() for a in PurePosixPath(canon).parents if a.as_posix() != "/"]


def is_path_under(path: str, root: str) -> bool:
    """Segment-safe containment: ``path`` IS ``root`` or lives inside it.

    Pure string check over already-canonical posix paths (see
    ``canonical_posix_path``) — ``/a/bc`` is NOT under ``/a/b``. The single
    containment predicate shared by the nested-project walk dedup
    (``real_project_cwd_fn._dedup_nested``) and the deepest-project-wins
    association (``deepest_project_id_for_path``) so the two can never drift.
    """
    r = root.rstrip("/")
    p = path.rstrip("/")
    return p == r or p.startswith(r + "/")
