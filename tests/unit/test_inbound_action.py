"""The desktop's ``inbound`` action forwards each local call to exactly one hub ``webhook`` verb."""

from flow_sdk.api.api_request import APIRequest
from flow_sdk.app.actions.inbound_action import HubCall, hub_call

CLAIM = "3f0b5c2e-1111-4a2b-9c3d-123456789abc"


def test_here_is_answered_locally():
    assert hub_call("GET", "here") == HubCall("LOCAL", None, "here")
    assert hub_call("DELETE", "here") is None


def test_mine_is_the_hub_list():
    assert hub_call("get", "mine") == HubCall("GET", None, "mine")


def test_chain_is_the_hub_chain():
    assert hub_call("POST", "/chain/") == HubCall("POST", None, "chain")


def test_claim_verbs_name_the_claim():
    assert hub_call("POST", f"{CLAIM}/set_target") == HubCall("POST", CLAIM, "set_target")
    assert hub_call("POST", f"{CLAIM}/probe") == HubCall("POST", CLAIM, "probe")


def test_delete_removes_one_claim():
    assert hub_call("DELETE", CLAIM) == HubCall("DELETE", CLAIM, None)


def test_anything_else_forwards_nothing():
    assert hub_call("POST", "mine") is None
    assert hub_call("GET", "chain") is None
    assert hub_call("GET", f"{CLAIM}/view") is None
    assert hub_call("POST", f"{CLAIM}/reply") is None
    assert hub_call("POST", f"{CLAIM}/retarget") is None
    assert hub_call("DELETE", "mine") is None
    assert hub_call("DELETE", f"{CLAIM}/probe") is None
    assert hub_call("PUT", CLAIM) is None
    assert hub_call("GET", "") is None


def test_the_local_path_parses_as_the_inbound_action():
    for sub in ("mine", "chain", f"{CLAIM}/set_target"):
        parsed = APIRequest.from_api_path(f"/api/v1/graph/data_source/inbound/{sub}")
        assert parsed.action == "inbound"
        assert parsed.sub_path == sub
        assert parsed.target_typeid is None
