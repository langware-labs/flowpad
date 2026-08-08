"""Best-effort diagnosis of a web app the user is looking at in the display.

Why this exists: the display embeds the app in a **cross-origin** iframe, and a
browser tells the host page almost nothing about a guest it cannot reach. A
navigation to a refused port still fires ``onload``; a ``redirect: 'manual'``
preflight of the ``get-host`` redirect resolves as an opaque redirect with
``status == 0`` whether the server is alive or dead. Both are measured facts,
pinned by tests. So the only honest place to ask "is this app actually working"
is here, from the machine that can talk to the port directly.

What this level can see: whether anything is listening, whether it speaks HTTP,
its status code, and whether the page has any content. Console errors and
uncaught exceptions need a real browser and are not available here.
"""

from __future__ import annotations

from typing import Any

import httpx
from bs4 import BeautifulSoup

# Response budget for the probe's single GET. This is the probe's SEMANTICS --
# a dev server that has not answered by now is a finding we want to REPORT
# ("nav_error: timeout"), not a flake to ride past -- so it must not be widened
# to make anything pass.
HTTP_PROBE_TIMEOUT_S = 5.0

# Every signal we extract (first text node, first visual element, first script)
# appears in the head or early body. Capping the parse keeps a single-file build
# with a multi-megabyte inlined bundle from costing real CPU per probe.
_PARSE_LIMIT = 128 * 1024

# Elements that paint without producing text, so a "no text" page is not blank.
_VISUAL_TAGS = ("img", "canvas", "svg", "video", "iframe", "object", "embed")


def blank_result(port: int, url: str) -> dict[str, Any]:
    """The probe's full shape, with every field at its 'nothing known' value.

    Declared in one place so the action, the tests and the frontend classifier
    all agree on the contract even when a probe bails out early.
    """
    return {
        "port": int(port),
        "url": url,
        "reachable": False,
        "is_http": False,
        "http_status": None,
        "content_length": None,
        "blank": False,
        "nav_error": None,
        "probe_error": None,
    }


def _looks_blank(body: str) -> bool:
    """True when the page can never show the user anything.

    A single-page app legitimately serves an empty ``<div id="root">`` and fills
    it in from JavaScript, so "no text in the HTML" on its own is NOT evidence of
    breakage -- treating it as such would flag every healthy React app. A page is
    blank only when nothing could fill it: no text, no visual element, and no
    script to run.
    """
    soup = BeautifulSoup(body[:_PARSE_LIMIT], "html.parser")
    if soup.get_text(strip=True):
        return False
    return not soup.find(list(_VISUAL_TAGS)) and not soup.find("script")


async def probe_webapp(url: str, port: int) -> dict[str, Any]:
    """Run the probe against a dev server and report what it finds.

    Never raises -- a probe that blew up is itself a result, reported as
    ``probe_error``.
    """
    result = blank_result(port, url)

    try:
        async with httpx.AsyncClient(timeout=HTTP_PROBE_TIMEOUT_S, follow_redirects=True) as client:
            response = await client.get(url)
    except httpx.TooManyRedirects:
        result["reachable"] = True
        result["is_http"] = True
        result["nav_error"] = "redirect_loop"
        return result
    except httpx.ConnectError:
        # Nothing accepted the connection: the app is not running. This is the
        # case the browser reports as a successful `onload`.
        result["nav_error"] = "connection_refused"
        return result
    except httpx.TimeoutException:
        # The port accepted a connection but never answered -- a hung dev server.
        result["reachable"] = True
        result["nav_error"] = "timeout"
        return result
    except httpx.HTTPError:
        # Past the connect stage, so something IS listening -- it just is not
        # speaking HTTP (a raw TCP listener, another protocol on a reused port).
        result["reachable"] = True
        result["nav_error"] = "not_http"
        return result
    except Exception as e:  # noqa: BLE001 - a broken probe must not break the display
        result["probe_error"] = f"{type(e).__name__}: {e}"
        return result

    body = response.text or ""
    result["reachable"] = True
    result["is_http"] = True
    result["http_status"] = int(response.status_code)
    result["content_length"] = len(body)
    if response.status_code < 400:
        result["blank"] = _looks_blank(body)
    return result
