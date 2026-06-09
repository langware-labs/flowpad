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
        response = await version_route.check_version()
    finally:
        version_route._cache.clear()

    assert response.hub == version_route.HubInfo(
        version="0.29.99",
        deployed_at="2026-06-07T10:15:00Z",
        generated_at="2026-06-07T10:12:30Z",
    )
