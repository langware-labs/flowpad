"""Unit tests for the shared semver helper (``flow_sdk/utils/semver.py``).

Mirrors the cases in ``electron/semver.test.js`` — the two implementations
must agree. Covers extraction from noisy text, missing/garbage input, the
"extra tag is newer" ordering rule, and the ``is_newer`` fallback.
"""

from __future__ import annotations

import pytest

from flow_sdk.utils.semver import (
    Semver,
    compare_semver,
    is_newer,
    string2semver,
)


# ── string2semver: extraction ────────────────────────────────────────────────
@pytest.mark.parametrize(
    "text,expected",
    [
        ("0.2.40", Semver(0, 2, 40, "")),
        ("v0.2.40", Semver(0, 2, 40, "")),
        ("V0.2.40", Semver(0, 2, 40, "")),
        ("flowpad v0.1.35", Semver(0, 1, 35, "")),
        ("flowpad v0.2.40-local", Semver(0, 2, 40, "local")),
        ("0.2.40-local", Semver(0, 2, 40, "local")),
        ("0.2.40+local", Semver(0, 2, 40, "local")),
        ("0.2.40.local", Semver(0, 2, 40, "local")),
        ("0.2.40_local", Semver(0, 2, 40, "local")),
        ("1.2.3-rc.1", Semver(1, 2, 3, "rc.1")),
        ("10.20.30", Semver(10, 20, 30, "")),
        ("  v2.3.4-dev  ", Semver(2, 3, 4, "dev")),
        ("released 1.2.3, enjoy", Semver(1, 2, 3, ",")),
        ("1.2.3.4", Semver(1, 2, 3, "4")),  # 4th segment becomes extra
    ],
)
def test_string2semver_extracts(text, expected):
    assert string2semver(text) == expected


# ── string2semver: missing numbers / garbage → None ──────────────────────────
@pytest.mark.parametrize(
    "text",
    [
        None,
        "",
        "   ",
        "garbage",
        "1",
        "1.2",
        "v1.2",
        "..",
        "1..3",
        "a.b.c",
        "version one",
    ],
)
def test_string2semver_returns_none(text):
    assert string2semver(text) is None


# ── ordering: extra tag is NEWER than no tag ──────────────────────────────────
def test_extra_is_newer_than_plain():
    plain = string2semver("2.3.4")
    tagged = string2semver("2.3.4-somenote")
    assert compare_semver(tagged, plain) == 1
    assert compare_semver(plain, tagged) == -1


def test_equal_versions():
    assert compare_semver(string2semver("1.2.3"), string2semver("1.2.3")) == 0
    assert compare_semver(string2semver("1.2.3-a"), string2semver("1.2.3-a")) == 0


@pytest.mark.parametrize(
    "lower,higher",
    [
        ("1.2.3", "1.2.4"),
        ("1.2.3", "1.3.0"),
        ("1.2.3", "2.0.0"),
        ("1.9.9", "2.0.0"),
        ("0.2.40", "0.2.40-local"),       # extra wins on tie
        ("1.2.3-alpha", "1.2.3-beta"),    # both tagged → lexical
        ("0.2.40-local", "0.2.41"),       # number beats tag
    ],
)
def test_ordering(lower, higher):
    lo, hi = string2semver(lower), string2semver(higher)
    assert compare_semver(lo, hi) == -1
    assert compare_semver(hi, lo) == 1


# ── is_newer: the production entry point ──────────────────────────────────────
@pytest.mark.parametrize(
    "current,latest,expected",
    [
        ("0.2.40", "0.2.41", True),
        ("0.2.41", "0.2.40", False),
        ("0.2.40", "0.2.40", False),
        ("0.2.40-local", "0.2.40", False),   # local is "newer", so 0.2.40 is not
        ("0.2.40", "0.2.40-local", True),    # the -local build is newer
        ("0.2.40-local", "0.2.41", True),    # real bump still wins
    ],
)
def test_is_newer(current, latest, expected):
    assert is_newer(current, latest) is expected


def test_is_newer_fallback_on_unparseable():
    # Neither parses → plain string inequality, never crashes.
    assert is_newer("garbage", "garbage") is False
    assert is_newer("garbage", "other") is True
