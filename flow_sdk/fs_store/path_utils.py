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
