"""``_safe_next`` — the same-origin redirect guard shared by /auth/login_callback
and /auth/gate.

Both routes reflect a caller-supplied ``next`` into a Location header, so the
guard is the only thing standing between them and an open redirect.
"""

from __future__ import annotations

import pytest

from flow_sdk.server.routes.auth import _safe_next

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.mark.parametrize("path", ["/", "/some/page", "/a?b=c", "/x#frag"])
def test_absolute_paths_pass_through(path):
    assert _safe_next(path) == path


@pytest.mark.parametrize(
    "hostile",
    [
        # Protocol-relative — a browser reads this as a host and leaves the
        # origin. startswith("/") admits it, which is the whole point of this
        # helper existing.
        "//evil.com",
        "///evil.com",
        "//evil.com/path",
        "https://evil.com",
        "http://evil.com",
        # Not absolute at all.
        "evil.com",
        "../evil",
    ],
)
def test_off_origin_targets_are_refused(hostile):
    assert _safe_next(hostile) == "/"


@pytest.mark.parametrize("empty", [None, ""])
def test_absent_falls_back_to_default(empty):
    assert _safe_next(empty) == "/"


def test_default_is_overridable():
    """login_callback passes default="" so an absent/unsafe next falls through to
    its success page rather than redirecting."""
    assert _safe_next(None, default="") == ""
    assert _safe_next("//evil.com", default="") == ""
