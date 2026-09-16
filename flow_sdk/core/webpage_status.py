"""Can this external web page be shown inside the display, and is it there at all?

Why the backend asks: the display embeds the page in a **cross-origin** iframe,
and the browser tells the host page nothing about it. Measured in Chrome: a frame
refused by ``X-Frame-Options: DENY``, a frame that loaded fine, and a frame
pointed at a dead port are indistinguishable -- all fire ``onload``, none fires
``onerror``, ``contentDocument`` is null and ``location`` throws for all three,
and the Resource Timing entry reports status 0 for all three. The refusal is
decided by response headers, and only a client that sees the response can read
them.

What this can and cannot say, since the backend is not the user's browser:

* **Framing is reliable.** ``X-Frame-Options`` / CSP ``frame-ancestors`` are set
  per site, not per session -- GitHub sends ``DENY`` on the 404 it gives an
  anonymous request just as it does on the logged-in page.
* **Reachability is reliable** for "nothing answers" (DNS, refused, hung).
* **The HTTP status is NOT a verdict.** No cookies: a private page 404s here and
  loads for the user; a bot filter 403s here and not in the browser. It is
  reported, never acted on.
"""

from __future__ import annotations

import socket
from typing import Optional
from urllib.parse import urlsplit

import httpx
from pydantic import ConfigDict

from flow_sdk.schema.data_spec.spec import DataSpec

# Response budget for a probe's single GET. This is the probe's SEMANTICS -- a
# server that has not answered by now is a finding we want to REPORT
# ("nav_error: timeout"), not a flake to ride past -- so it must not be widened
# to make anything pass. Shared with ``webapp_probe``.
HTTP_PROBE_TIMEOUT_S = 5.0

_DEFAULT_PORTS = {"http": 80, "https": 443}


class WebpageStatusRequest(DataSpec):
    """A page to check, and the origin that wants to frame it.

    ``embedder_origin`` is the display's own origin (``window.location.origin``);
    ``SAMEORIGIN`` and ``frame-ancestors`` are judged against it.
    """

    model_config = ConfigDict(frozen=True)
    url: str
    embedder_origin: str


class WebpageStatus(DataSpec):
    """What the check found. Every field defaults to "nothing known"."""

    model_config = ConfigDict(frozen=True)
    url: str
    reachable: bool = False
    http_status: Optional[int] = None
    # invalid_url | dns_failure | connection_refused | timeout | redirect_loop | not_http | probe_error
    nav_error: Optional[str] = None
    frame_blocked: bool = False
    # The header that refused us, verbatim enough to quote in a Details line.
    frame_block_reason: Optional[str] = None


# --- framing rules -----------------------------------------------------------


def _origin(url: str) -> Optional[tuple[str, str, int]]:
    try:
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        port = parts.port or _DEFAULT_PORTS.get(scheme)
    except ValueError:
        return None
    if not parts.hostname or port is None:
        return None
    return scheme, parts.hostname.lower(), port


def _same_origin(a: str, b: str) -> bool:
    origin = _origin(a)
    return origin is not None and origin == _origin(b)


def _scheme_allows(source_scheme: str, embedder_scheme: str) -> bool:
    # CSP lets an insecure scheme source match its secure upgrade, not the reverse.
    return source_scheme == embedder_scheme or (source_scheme, embedder_scheme) == ("http", "https")


def _source_allows(source: str, embedder: str, target_url: str) -> bool:
    """One ``frame-ancestors`` source expression against the embedding origin.

    Covers what an http(s) embedder can meet: ``*``, ``'self'``, scheme sources
    (``https:``) and host sources with optional scheme, ``*.`` host wildcard and
    port or ``*`` port. Paths are ignored -- an ancestor is an origin.
    """
    token = source.lower()
    if token == "*":
        return True
    if token == "'self'":
        return _same_origin(embedder, target_url)
    if token.startswith("'"):
        return False  # no other keyword means anything for frame-ancestors
    origin = _origin(embedder)
    if origin is None:
        return False
    e_scheme, e_host, e_port = origin
    if token.endswith(":"):
        return _scheme_allows(token[:-1], e_scheme)

    scheme, sep, rest = token.partition("://")
    if not sep:  # a scheme-less source takes the protected page's scheme
        scheme, rest = urlsplit(target_url).scheme.lower(), token
    if not _scheme_allows(scheme, e_scheme):
        return False
    host, _, port = rest.split("/", 1)[0].partition(":")
    if not (e_host.endswith(host[1:]) if host.startswith("*.") else host == e_host):
        return False
    if port == "*":
        return True
    if port:
        return port.isdigit() and int(port) == e_port
    return e_port == _DEFAULT_PORTS[e_scheme]


def frame_block_reason(
    headers: httpx.Headers | dict[str, str] | list[tuple[str, str]],
    target_url: str,
    embedder_origin: str,
) -> Optional[str]:
    """Return why a browser would refuse to frame this response, or ``None``.

    Follows what Chrome enforces, not what the headers hope for:

    * A ``frame-ancestors`` directive in any enforced CSP makes ``X-Frame-Options``
      irrelevant. ``Content-Security-Policy-Report-Only`` blocks nothing, and a
      ``<meta>`` CSP cannot carry ``frame-ancestors`` at all -- neither is read.
    * Every policy is enforced on its own, so ANY one refusing is a refusal.
      ``'none'`` refuses only when it stands alone.
    * ``X-Frame-Options``: ``DENY`` refuses; ``SAMEORIGIN`` refuses a foreign
      embedder; unknown values (the obsolete ``ALLOW-FROM`` included) are ignored.
    """
    h = httpx.Headers(headers)

    directives = [
        directive.strip()
        for value in h.get_list("content-security-policy")
        for policy in value.split(",")
        for directive in policy.split(";")
        if directive.split()[:1] and directive.split()[0].lower() == "frame-ancestors"
    ]
    if directives:
        for directive in directives:
            sources = [s for s in directive.split()[1:] if s.lower() != "'none'"]
            if not any(_source_allows(s, embedder_origin, target_url) for s in sources):
                return f"content-security-policy: {directive}"
        return None

    xfo = {token.strip().lower() for value in h.get_list("x-frame-options") for token in value.split(",")}
    if "deny" in xfo:
        return "x-frame-options: DENY"
    if "sameorigin" in xfo and not _same_origin(embedder_origin, target_url):
        return "x-frame-options: SAMEORIGIN"
    return None


# --- the fetch ---------------------------------------------------------------


def _is_dns_failure(exc: BaseException) -> bool:
    current: Optional[BaseException] = exc
    while current is not None:
        if isinstance(current, socket.gaierror):
            return True
        current = current.__cause__ or current.__context__
    return False


def nav_error_for(exc: httpx.HTTPError) -> tuple[str, bool]:
    """``(nav_error, reachable)`` for a fetch that failed -- the one vocabulary
    both this check and ``webapp_probe`` report in."""
    if isinstance(exc, httpx.TooManyRedirects):
        return "redirect_loop", True
    if isinstance(exc, httpx.ConnectError):
        # Nothing accepted the connection -- or there was no address to try.
        return ("dns_failure" if _is_dns_failure(exc) else "connection_refused"), False
    if isinstance(exc, httpx.TimeoutException):
        # Something accepted the connection but never answered.
        return "timeout", True
    # Past the connect stage, so something IS listening -- it just is not
    # speaking HTTP (a raw TCP listener, another protocol on a reused port).
    return "not_http", True


async def check_webpage_status(url: str, embedder_origin: str) -> WebpageStatus:
    """Fetch ``url`` once and report reachability and framing. Never raises."""
    parts = urlsplit(url)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        return WebpageStatus(url=url, nav_error="invalid_url")

    try:
        async with (
            httpx.AsyncClient(
                timeout=HTTP_PROBE_TIMEOUT_S,
                follow_redirects=True,
                headers={"User-Agent": "Mozilla/5.0 (compatible; Flowpad-WebpageStatus/1.0)"},
            ) as client,
            # Headers are the whole answer; streaming lets us close before the body.
            client.stream("GET", url) as response,
        ):
            reason = frame_block_reason(response.headers, str(response.url), embedder_origin)
            return WebpageStatus(
                url=url,
                reachable=True,
                http_status=response.status_code,
                frame_blocked=reason is not None,
                frame_block_reason=reason,
            )
    except httpx.HTTPError as e:
        nav_error, reachable = nav_error_for(e)
        return WebpageStatus(url=url, reachable=reachable, nav_error=nav_error)
    except Exception:  # noqa: BLE001 - a broken check must not break the display
        return WebpageStatus(url=url, nav_error="probe_error")
