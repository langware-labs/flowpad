"""Tests for API path parser.

Migrated from flowpad/hub/tests/unit/test_api_path_parser.py.
Only the APIRequest parsing tests that don't require cloud fixtures
are included.

Skipped tests (require cloud infra / circular import workaround):
- test_api_request_parse (needs MicroApp entity, not available in flow-cli)
- test_empty through test_action_with_subpath (need RequestInfo + urls_service + action registry)
- test_convert_namespace_to_typeid (needs Workspace.save())
- test_convert_propid_to_typeid (needs Workspace.save())
"""

import pytest

# Entity types must be registered for the parser to recognize them
from flow_sdk.core.loaders import load_entities

load_entities()

from flow_sdk.api.api_request import APIRequest
from flow_sdk.api.type_id import TypeId


async def test_api_request_parse_no_graph():
    url = "http://localhost:8000/login"
    api_request: APIRequest = APIRequest.from_api_path(url)
    assert api_request.raw_api_path == url
    assert api_request.target_typeid is None
    assert api_request.action is None
    assert api_request.sub_path is None
    assert api_request.is_graph_path() is False
    assert api_request.segments == []


async def test_api_request_parse_type_only():
    """Test parsing a graph path with just a type (list operation)."""
    url = "http://localhost:8000/api/v1/graph/user"
    api_request: APIRequest = APIRequest.from_api_path(url)
    assert api_request.is_graph_path() is True
    assert api_request.segments == ["user"]
    assert api_request.target_typeid is None
    assert api_request.direct_resource_type == "user"
    assert api_request.action is None


async def test_api_request_parse_type_and_id():
    """Test parsing a graph path with type and ID (get by ID)."""
    eid = "cd15bf08-fb57-48f5-a657-0f9f89b5a635"
    url = f"http://localhost:8000/api/v1/graph/project/{eid}"
    api_request: APIRequest = APIRequest.from_api_path(url)
    assert api_request.is_graph_path() is True
    assert api_request.target_typeid is not None
    assert api_request.target_typeid.type == "project"
    assert api_request.target_typeid.id == eid


async def test_api_request_parse_type_id_action_subpath():
    """Test parsing a full graph API path with type/id/action/subpath."""
    etype = "compute_node"
    eid = "cd15bf08-fb57-48f5-a657-0f9f89b5a635"
    eaction = "terminal-command"
    subpath = "run"
    url = f"http://localhost:8000/api/v1/graph/{etype}/{eid}/{eaction}/{subpath}"
    api_request: APIRequest = APIRequest.from_api_path(url)
    assert api_request.raw_api_path == url
    assert api_request.target_typeid == TypeId(type=etype, id=eid)
    assert api_request.action == eaction
    assert api_request.sub_path == subpath
    assert api_request.api_path == f"/api/v1/graph/{etype}/{eid}/{eaction}/{subpath}"
    assert api_request.segments == [etype, eid, eaction, subpath]


if __name__ == "__main__":
    pytest.main()
