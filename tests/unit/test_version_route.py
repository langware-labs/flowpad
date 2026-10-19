import httpx
import pytest

from flow_sdk.server.routes import version as version_route


@pytest.mark.asyncio
async def test_check_version_exposes_hub_build_timestamps(monkeypatch):
    version_route._cache.clear()

    async def fake_fetch_pypi(_client):
        return version_route.PypiInfo(
            current="0.1.0",
            latest="0.1.0",
            update_available=False,
        )

    async def fake_fetch_github(_client):
        return [], None

    async def fake_hub_info():
        return {
            "version": "0.29.99",
            "deployed_at": "2026-06-07T10:15:00Z",
            "generated_at": "2026-06-07T10:12:30Z",
        }

    monkeypatch.setattr(version_route, "_fetch_pypi", fake_fetch_pypi)
    monkeypatch.setattr(version_route, "_fetch_github", fake_fetch_github)
    monkeypatch.setattr(version_route.hub, "get_info", fake_hub_info)

    try:
        response = (await version_route.check_version()).data
    finally:
        version_route._cache.clear()

    assert response.hub == version_route.HubInfo(
        version="0.29.99",
        deployed_at="2026-06-07T10:15:00Z",
        generated_at="2026-06-07T10:12:30Z",
    )


@pytest.mark.asyncio
async def test_check_again_skips_the_cache_that_a_plain_open_reuses(monkeypatch):
    """A release published inside the cache window must show on "Check again"."""
    version_route._cache.clear()
    published = ["0.2.182"]

    async def fake_fetch_pypi(_client):
        return version_route.PypiInfo(current="0.2.182", latest=published[0])

    async def fake_fetch_github(_client):
        return [], None

    async def fake_hub_info():
        return None

    monkeypatch.setattr(version_route, "_fetch_pypi", fake_fetch_pypi)
    monkeypatch.setattr(version_route, "_fetch_github", fake_fetch_github)
    monkeypatch.setattr(version_route.hub, "get_info", fake_hub_info)

    try:
        assert (await version_route.check_version()).data.pypi.latest == "0.2.182"
        published[0] = "0.2.183"
        assert (await version_route.check_version()).data.pypi.latest == "0.2.182"
        assert (await version_route.check_version(refresh=True)).data.pypi.latest == "0.2.183"
    finally:
        version_route._cache.clear()


@pytest.mark.asyncio
async def test_pypi_fetch_skips_the_cdn_edge_cache():
    """PyPI's edges hold the project JSON for 15 minutes; each fetch must miss them."""
    seen: list[httpx.URL] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url)
        return httpx.Response(200, json={"info": {"version": "0.2.183"}, "releases": {}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        first = await version_route._fetch_pypi(client)
        await version_route._fetch_pypi(client)

    assert first.latest == "0.2.183"
    assert all(url.path == "/pypi/flowpad/json" for url in seen)
    assert seen[0].params.get("t") and seen[0].params["t"] != seen[1].params["t"]
