"""
Schema API tests.

Ported from FlowPad: flowpad/hub/tests/api/test_schema.py

Adapted for minihub:
- Schema payload is provided via `/api/v1/graph/bootstrap` (`data.schemas`)
- There is no standalone `/schema` endpoint in this repo
"""

import time
from typing import Any, Dict, List, Optional

from jsonschema import ValidationError, validate
from pydantic import BaseModel


class SchemaField(BaseModel):
    type: str
    format: Optional[str] = None
    minimum: Optional[int] = None
    maximum: Optional[int] = None
    enum: Optional[List[Any]] = None
    items: Optional[Any] = None


class JsonSchema(BaseModel):
    type: str
    properties: Dict[str, SchemaField]
    required: Optional[List[str]] = None


def validate_entity_schema(entity: dict, schema: Any):
    assert schema is not None
    assert "properties" in schema
    for key, value in schema["properties"].items():
        assert value is not None
        assert not key.endswith("_")
    try:
        validate(entity, schema)
    except ValidationError as e:
        raise AssertionError(f"Entity schema validation failed: {e}") from e


async def test_get_builtin_single_schema(bootstrapped_client):
    client = bootstrapped_client

    bootstrap_res = await client.get("/api/v1/graph/bootstrap")
    assert bootstrap_res.status_code == 200, bootstrap_res.text
    bootstrap_data = bootstrap_res.json()["data"]

    schemas: List[dict[str, Any]] = bootstrap_data["schemas"]
    user_schema = next((s for s in schemas if s.get("properties", {}).get("type", {}).get("const") == "user"), None)
    assert user_schema is not None

    users_res = await client.get("/api/v1/graph/user")
    assert users_res.status_code == 200, users_res.text
    users = users_res.json()["data"]
    assert users and isinstance(users, list)
    local_user = users[0]

    validate_entity_schema(local_user, user_schema)

    # Break schema type const and verify validation fails.
    user_schema["properties"]["type"]["const"] = "no_type"
    try:
        validate(local_user, user_schema)
        raise AssertionError("User schema validation failed to raise unknown type error")
    except ValidationError:
        pass


async def test_get_builtin_all_schema(bootstrapped_client):
    client = bootstrapped_client

    start_time = time.time()
    response = await client.get("/api/v1/graph/bootstrap")
    end_time = time.time()

    duration_ms = (end_time - start_time) * 1000
    print(f"\nSchema bootstrap call duration: {duration_ms:.2f} ms")

    assert response.status_code == 200, response.text
    schemas: List[Any] = response.json()["data"]["schemas"]
    assert schemas is not None
    assert len(schemas) > 1
    print(f"Retrieved {len(schemas)} schemas")


async def test_bootstrap_includes_agent_and_skill_schemas(bootstrapped_client):
    client = bootstrapped_client

    response = await client.get("/api/v1/graph/bootstrap")

    assert response.status_code == 200, response.text
    schemas: List[dict[str, Any]] = response.json()["data"]["schemas"]
    schema_types = {
        schema.get("properties", {}).get("type", {}).get("const")
        for schema in schemas
    }
    assert "agent" in schema_types
    assert "skill" in schema_types
