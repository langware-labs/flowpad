"""Webpage status check: can the display frame this page, and is it there?

Header rules are pinned as a pure table (they are what Chrome enforces, and the
cases are cheap). The fetch is driven against a real local server sending real
headers, not a mocked transport -- the same reasoning as ``test_webapp_probe``.
"""

from __future__ import annotations

import asyncio
import socket
from collections.abc import Iterator

import pytest

from flow_sdk.core.webpage_status import check_webpage_status, frame_block_reason
from tests.unit._ingest_helpers import local_http_server

APP = "http://localhost:9007"
SITE = "https://github.com/langware-labs/flowpad-hub/pull/1138"


# --- header rules -----------------------------------------------------------


@pytest.mark.parametrize(
    ("headers", "target", "blocked"),
    [
        # What GitHub actually sends, on the anonymous 404 as on the real page.
        ([("x-frame-options", "DENY")], SITE, True),
        # google.com
        ([("x-frame-options", "SAMEORIGIN")], "https://www.google.com/", True),
        ([("x-frame-options", "SAMEORIGIN")], f"{APP}/page", False),
        # No framing headers at all: example.com, youtube embeds.
        ([], "https://example.com/", False),
        # Chrome ignores the obsolete ALLOW-FROM rather than honouring it.
        ([("x-frame-options", "ALLOW-FROM https://other.test")], SITE, False),
        # frame-ancestors wins over X-Frame-Options, in both directions.
        ([("x-frame-options", "DENY"), ("content-security-policy", f"frame-ancestors {APP}")], SITE, False),
        ([("content-security-policy", "default-src 'self'; frame-ancestors 'self'")], SITE, True),
        ([("content-security-policy", "frame-ancestors 'self'")], f"{APP}/x", False),
        ([("content-security-policy", "frame-ancestors *")], SITE, False),
        ([("content-security-policy", "frame-ancestors http:")], SITE, False),
        ([("content-security-policy", "frame-ancestors https:")], SITE, True),
        ([("content-security-policy", "frame-ancestors http://localhost:*")], SITE, False),
        ([("content-security-policy", "frame-ancestors http://localhost:8000")], SITE, True),
        ([("content-security-policy", "frame-ancestors https://*.github.com")], SITE, True),
        # 'none' beside a real source is ignored, not a veto.
        ([("content-security-policy", f"frame-ancestors 'none' {APP}")], SITE, False),
        # Report-only never blocks.
        ([("content-security-policy-report-only", "frame-ancestors 'none'")], SITE, False),
        # Two enforced policies: either one refusing is a refusal.
        (
            [("content-security-policy", "frame-ancestors *"), ("content-security-policy", "frame-ancestors 'none'")],
            SITE,
            True,
        ),
    ],
)
def test_frame_block_rules(headers, target, blocked):
    assert (frame_block_reason(headers, target, APP) is not None) is blocked


def test_block_reason_names_the_header():
    assert frame_block_reason([("x-frame-options", "DENY")], SITE, APP) == "x-frame-options: DENY"
    reason = frame_block_reason([("content-security-policy", "frame-ancestors 'none'")], SITE, APP)
    assert reason == "content-security-policy: frame-ancestors 'none'"


# --- the fetch --------------------------------------------------------------

_ROUTES: dict[str, tuple[int, dict[str, str]]] = {
    "/open": (200, {}),
    "/deny": (200, {"X-Frame-Options": "DENY"}),
    "/deny-404": (404, {"X-Frame-Options": "DENY"}),
    "/redirect-to-deny": (302, {"Location": "/deny"}),
    "/loop": (302, {"Location": "/loop"}),
}


def _respond(path, _headers):
    status, headers = _ROUTES.get(path, (404, {}))
    return status, b"<html><body>hi</body></html>", {"Content-Type": "text/html", **headers}


@pytest.fixture(scope="module")
def site() -> Iterator[str]:
    with local_http_server(_respond) as base:
        yield base


def _check(url: str):
    return asyncio.run(check_webpage_status(url, APP))


def test_frameable_page(site):
    status = _check(f"{site}/open")
    assert status.reachable and status.http_status == 200
    assert status.frame_blocked is False


def test_refusing_page_is_blocked(site):
    status = _check(f"{site}/deny")
    assert status.frame_blocked is True
    assert status.frame_block_reason == "x-frame-options: DENY"


def test_block_is_found_on_an_error_page(site):
    """The GitHub case: no cookies means a 404, but the refusal is still there."""
    status = _check(f"{site}/deny-404")
    assert status.http_status == 404
    assert status.frame_blocked is True


def test_block_is_read_from_the_final_response(site):
    # The redirect itself carries no framing header; only /deny does.
    assert _check(f"{site}/redirect-to-deny").frame_blocked is True


def test_redirect_loop(site):
    assert _check(f"{site}/loop").nav_error == "redirect_loop"


def test_closed_port_is_refused():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    status = _check(f"http://127.0.0.1:{port}/")
    assert status.reachable is False
    assert status.nav_error == "connection_refused"


def test_unknown_host_is_a_dns_failure():
    # `.invalid` is reserved (RFC 6761) and never resolves.
    status = _check("http://no-such-host.invalid/")
    assert status.reachable is False
    assert status.nav_error == "dns_failure"


@pytest.mark.parametrize("url", ["", "not a url", "file:///etc/passwd", "javascript:alert(1)", "http://"])
def test_only_http_urls_are_fetched(url):
    assert _check(url).nav_error == "invalid_url"
