"""
Bootstrap API tests.

Migrated from FlowPad:
flowpad/hub/tests/api/test_bootstrap.py

Adapted for minihub zero-auth behavior:
- bootstrap always returns the local user
- visitor flow is not used
"""


def _assert_local_entity(entity: dict, entity_type: str) -> None:
    assert entity["id"]
    assert entity["type"] == entity_type
    assert entity["uname"] == "local"
    assert entity["visitor_role"] == "owner"


async def test_bootstrap_returns_local_user_and_schemas(client):
    response = await client.get("/api/v1/graph/bootstrap")
    assert response.status_code == 200, response.text

    payload = response.json()
    assert payload["status"] == "SUCCESS"
    assert "data" in payload

    data = payload["data"]

    # Type metadata is delivered as `data.types` (list of TypeInfo), each with a
    # nested JSON `schema`. Pull the schemas out of it.
    types = data["types"]
    assert isinstance(types, list)
    assert len(types) > 0
    schemas = [t["schema"] for t in types if isinstance(t.get("schema"), dict)]
    assert len(schemas) > 0
    assert any(s.get("properties", {}).get("type", {}).get("const") == "flow" for s in schemas)

    user = data["user"]
    assert isinstance(user, dict)
    _assert_local_entity(user, "user")

    # Sensitive user fields should not be exposed in bootstrap payload.
    assert "salt_" not in user
    assert "hashed_password_" not in user

    assert data["domain"] is None
    assert data["visitor"] is None

    _assert_local_entity(data["default_project"], "project")
    _assert_local_entity(data["default_workspace"], "workspace")

    env = data["env"]
    assert env["env_name"] == "desktop"
    assert "cloud_api_url" in env

    desktop_info = data["desktop_info"]
    assert isinstance(desktop_info, dict)
    assert isinstance(desktop_info["llm_providers"], list)
    assert isinstance(desktop_info["installed_agents"], list)
    assert isinstance(desktop_info["cloud_login_available"], bool)
    assert isinstance(desktop_info["paths"], dict)
    assert "workspace" in desktop_info["paths"]


async def test_bootstrap_is_idempotent_for_local_entities(client):
    first = (await client.get("/api/v1/graph/bootstrap")).json()["data"]
    second = (await client.get("/api/v1/graph/bootstrap")).json()["data"]

    assert first["user"]["id"] == second["user"]["id"]
    assert first["default_project"]["id"] == second["default_project"]["id"]
    assert first["default_workspace"]["id"] == second["default_workspace"]["id"]
