"""Serving coverage for MicroApp — the delivery plane of the app continuum.

An app is one Artifact with up to two companions: a Deployment (dev server on a
port) and a MicroApp (built output the backend serves at its own origin). This
suite covers the second: that we serve the right bytes, revalidate them, refuse
to escape the app folder, tell an unbuilt app apart from a missing file, and
hand every served document the API origin its SDK needs.

The API-origin injection is the load-bearing one: it is what makes a served app
talk to the backend that served it — the same document works on a laptop and in
a cloud sandbox with nothing to configure.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.faas.micro_app import AppLocationType, MicroApp
from flow_sdk.builtin.faas.serve_static import API_ORIGIN_SNIPPET


def _view_url(app: MicroApp, sub_path: str = "") -> str:
    return f"/api/v1/graph/micro_app/{app.id}/view/{sub_path}".rstrip("/")


async def _make_app(tmp_path, *, build: bool = True) -> MicroApp:
    dist = tmp_path / "todo-app" / "dist"
    if build:
        dist.mkdir(parents=True)
        (dist / "index.html").write_text("<html><head><title>Todo</title></head><body>todo</body></html>")
        (dist / "app.js").write_text("console.log('todo')")
        (dist / "secret-sibling.txt").write_text("in-app file")
        (tmp_path / "todo-app" / "outside.txt").write_text("OUTSIDE THE SERVING ROOT")
    app = MicroApp(
        name="Todo",
        location_type=AppLocationType.Artifact,
        location_root=str(dist),
    )
    await app.save()
    return app


@pytest.mark.asyncio
async def test_serves_index_with_api_origin_injected(bootstrapped_client, user, tmp_path):
    app = await _make_app(tmp_path)

    resp = await bootstrapped_client.get(_view_url(app))

    assert resp.status_code == 200, resp.text
    body = resp.text
    assert "todo" in body
    # The page's SDK resolves the backend that served it — not a baked URL.
    assert API_ORIGIN_SNIPPET in body
    # <base> so the app's relative asset URLs resolve under the view path.
    assert "<base" in body


@pytest.mark.asyncio
async def test_asset_carries_etag_and_revalidates(bootstrapped_client, user, tmp_path):
    app = await _make_app(tmp_path)

    first = await bootstrapped_client.get(_view_url(app, "app.js"))
    assert first.status_code == 200
    assert first.text.strip() == "console.log('todo')"
    etag = first.headers.get("etag")
    assert etag

    again = await bootstrapped_client.get(_view_url(app, "app.js"), headers={"If-None-Match": etag})
    assert again.status_code == 304


@pytest.mark.asyncio
async def test_unknown_path_falls_back_to_index(bootstrapped_client, user, tmp_path):
    """A client-side-routed app must not 404 its own deep links."""
    app = await _make_app(tmp_path)

    resp = await bootstrapped_client.get(_view_url(app, "todos/42"))

    assert resp.status_code == 200
    assert "todo" in resp.text


@pytest.mark.asyncio
async def test_traversal_out_of_the_app_is_refused(bootstrapped_client, user, tmp_path):
    """The URL layer decodes `..%2F..` into literal `..` segments before we see
    them, so the resolve-then-compare check is the only thing standing between a
    served app and the rest of the disk.

    Percent-encoded on purpose: a bare `../` is normalized away by any
    conforming client, so it would test the client, not us.
    """
    app = await _make_app(tmp_path)

    resp = await bootstrapped_client.get(_view_url(app, "%2E%2E%2Foutside.txt"))

    assert resp.status_code == 403, resp.text
    assert "OUTSIDE THE SERVING ROOT" not in resp.text


@pytest.mark.asyncio
async def test_unbuilt_app_is_a_distinct_404(bootstrapped_client, user, tmp_path):
    """Registered but never built is a normal early state, not a server error.

    It must also be distinguishable from "no such file", because the display
    shows a build CTA for one and nothing for the other.
    """
    app = await _make_app(tmp_path, build=False)

    resp = await bootstrapped_client.get(_view_url(app))

    assert resp.status_code == 404
    assert "not built" in resp.text.lower()


@pytest.mark.asyncio
async def test_artifact_id_must_be_a_valid_entity_id(bootstrapped_client, user, tmp_path):
    """Same gate as Deployment: an id from outside the minter is not adopted."""
    with pytest.raises(ValueError):
        MicroApp(
            name="Bad",
            location_type=AppLocationType.Artifact,
            location_root=str(tmp_path),
            artifact_id="0192f5c8-7e2a-7000-8000-0242ac120002",  # v7
        )
