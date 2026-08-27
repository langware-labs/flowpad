"""``fs/serve`` — the route that gives a shown HTML file an address of its own.

The pane that renders these files used to paste their markup into an iframe as
``srcDoc``. A ``srcdoc`` document has no url, so the browser resolved every
relative reference in it against the PARENT document — the app's dock route —
and ``<a href="page2.html">`` became ``/dock/shell/page2.html``: no such file,
a blank pane locally and the cookie-gate's Forbidden page on a gated sandbox.
Sibling images, stylesheets, ``#anchors`` and ``srcset`` all failed the same
way, and each was patched separately in the frontend.

This route ends that class by serving the file at a url whose tail IS the
file's path, so the browser resolves siblings correctly with no rewriting.
What is asserted here is exactly what the frontend is then allowed to stop
doing:

* the document is served for RENDERING, not downloading (``download`` says
  attachment; that is the one difference callers see);
* the url mirrors the path, so a sibling fetched relative to it is that
  sibling — the property the deleted click-interceptor existed to fake;
* a missing file is a 404 and NOT the folder's ``index.html`` — the app
  fallback would answer a missing page with an unrelated one;
* nothing is cached, because a file being iterated on is not a release;
* non-ASCII survives, which is a host-encoding contract with its own guard
  (``tests/unit/test_serve_static_encoding.py``) and is re-checked here because
  a 200 carrying mojibake is a failure of this route too.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.faas.serve_static import API_ORIGIN_SNIPPET

SITE = "<!doctype html><html><head><title>Clouds</title></head><body>{body}</body></html>"


def _serve_url(abs_path: str) -> str:
    return f"/api/v1/graph/compute_node/@local/fs/serve{abs_path}"


def _download_url(abs_path: str) -> str:
    return f"/api/v1/graph/compute_node/@local/fs/download{abs_path}"


@pytest.fixture
def site(tmp_path):
    """A two-page static site — the shape that exposed the bug."""
    root = tmp_path / "clouds-site"
    root.mkdir()
    (root / "index.html").write_text(
        SITE.format(body='<a href="cloud-types.html">go</a><a href="#mid">mid</a><h2 id="mid">M</h2>'),
        encoding="utf-8",
    )
    (root / "cloud-types.html").write_text(SITE.format(body="<h1>Types</h1>"), encoding="utf-8")
    (root / "style.css").write_text("body{color:red}", encoding="utf-8")
    return root


@pytest.mark.asyncio
async def test_serves_html_inline_for_rendering(bootstrapped_client, user, site):
    resp = await bootstrapped_client.get(_serve_url(str(site / "index.html")))

    assert resp.status_code == 200, resp.text
    assert "cloud-types.html" in resp.text
    # Inline: the browser renders it. `download` would say attachment here, and
    # that single header is the reason this route exists alongside it.
    assert "attachment" not in (resp.headers.get("content-disposition") or "")
    assert resp.headers["content-type"].startswith("text/html")
    # Served documents are handed the origin of the backend that served them.
    assert API_ORIGIN_SNIPPET in resp.text


@pytest.mark.asyncio
async def test_download_still_attaches(bootstrapped_client, user, site):
    """The sibling route is unchanged — `serve` was added beside it, not over it."""
    resp = await bootstrapped_client.get(_download_url(str(site / "index.html")))

    assert resp.status_code == 200, resp.text
    assert "attachment" in resp.headers.get("content-disposition", "")


@pytest.mark.asyncio
async def test_sibling_resolves_relative_to_the_served_page(bootstrapped_client, user, site):
    """The whole point: the url's tail is the path, so `page2.html` beside the
    page IS that file. This is what the frontend's click-interceptor faked."""
    page = _serve_url(str(site / "index.html"))
    sibling = page.rsplit("/", 1)[0] + "/cloud-types.html"

    resp = await bootstrapped_client.get(sibling)

    assert resp.status_code == 200, resp.text
    assert "Types" in resp.text


@pytest.mark.asyncio
async def test_sibling_asset_is_served_with_its_own_mime(bootstrapped_client, user, site):
    """Assets used to be inlined as data: uris (with 2MB/8MB ceilings) because
    the frame could not fetch them. Now they are ordinary requests."""
    resp = await bootstrapped_client.get(_serve_url(str(site / "style.css")))

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/css")
    assert "color:red" in resp.text


@pytest.mark.asyncio
async def test_missing_file_is_404_not_the_folder_index(bootstrapped_client, user, site):
    """An app serves index.html for an unknown path because its ROUTER handles
    it. A single file has no router, so the fallback would dress a missing file
    as a working page — the least debuggable answer available."""
    resp = await bootstrapped_client.get(_serve_url(str(site / "no-such-page.html")))

    assert resp.status_code == 404
    assert "Clouds" not in resp.text


@pytest.mark.asyncio
async def test_nothing_is_cached(bootstrapped_client, user, site):
    """A built app's assets may sit in the cache for an hour; a file the agent
    is still editing may not, or the next version never reaches the screen."""
    resp = await bootstrapped_client.get(_serve_url(str(site / "style.css")))

    assert resp.status_code == 200
    assert "no-store" in resp.headers.get("cache-control", "")


@pytest.mark.asyncio
async def test_non_ascii_page_is_served_intact(bootstrapped_client, user, tmp_path):
    """A 200 is not a pass. The served text must equal the bytes on disk — see
    tests/unit/test_serve_static_encoding.py for why CI alone cannot prove it."""
    page = tmp_path / "hebrew.html"
    page.write_text(SITE.format(body="<h1>ניהול משימות</h1>"), encoding="utf-8")

    resp = await bootstrapped_client.get(_serve_url(str(page)))

    assert resp.status_code == 200, resp.text
    assert "ניהול משימות" in resp.text
