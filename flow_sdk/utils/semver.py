"""Shared semver-ish parsing and comparison.

This module is mirrored 1:1 in ``electron/semver.js`` — the ``SEMVER_RE``
pattern and the ``string2semver`` / comparison rules MUST stay byte-for-byte
equivalent across the two. If you change one, change the other.

Rules:
  * Extract the FIRST ``<num>.<num>.<num>`` triple found anywhere in a string
    (so "flowpad v0.2.40" and "v0.2.40-local" both parse).
  * Anything trailing the patch number is the "extra" tag (e.g. the ``-local``
    in ``0.2.40-local``). A leading ``-``/``+``/``.``/``_`` separator is stripped.
  * A version WITH an extra tag is considered NEWER than the same version
    without one — i.e. ``2.3.4-somenote > 2.3.4`` (note: this is the OPPOSITE
    of the SemVer pre-release rule; it is intentional for this project).
  * Missing numbers / garbage / empty input → ``string2semver`` returns ``None``.
"""

from __future__ import annotations

import re
from typing import NamedTuple, Optional

# SHARED REGEX — mirror of SEMVER_RE in electron/semver.js.
# Captures major, minor, patch, and any trailing non-space "extra" tag.
SEMVER_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)([^\s]*)")

# Leading separators stripped off the extra tag before it is stored/compared.
_EXTRA_LEAD_RE = re.compile(r"^[-+._]+")


class Semver(NamedTuple):
    major: int
    minor: int
    patch: int
    extra: str


def string2semver(text: Optional[str]) -> Optional[Semver]:
    """Parse the first ``<num>.<num>.<num>[extra]`` out of *text*.

    Returns ``None`` when no full major.minor.patch triple is present
    (missing numbers, empty string, garbage, ``None``, …).
    """
    if not text:
        return None
    m = SEMVER_RE.search(text)
    if not m:
        return None
    major, minor, patch, extra = m.groups()
    extra = _EXTRA_LEAD_RE.sub("", extra or "")
    return Semver(int(major), int(minor), int(patch), extra)


def _cmp_key(v: Semver) -> tuple:
    # An extra tag sorts AFTER (i.e. newer than) no tag; when both have one,
    # fall back to a lexical compare of the tags.
    return (v.major, v.minor, v.patch, 1 if v.extra else 0, v.extra)


def compare_semver(a: Semver, b: Semver) -> int:
    """Return -1 if ``a < b``, 0 if equal, 1 if ``a > b`` (shared ordering)."""
    ka, kb = _cmp_key(a), _cmp_key(b)
    return (ka > kb) - (ka < kb)


def is_newer(current: str, latest: str) -> bool:
    """True if *latest* is a newer version than *current*.

    Falls back to plain string inequality when either side cannot be parsed,
    so behaviour never silently regresses to "no update" on odd input.
    """
    cur = string2semver(current)
    lat = string2semver(latest)
    if cur is None or lat is None:
        return latest != current
    return compare_semver(lat, cur) > 0
