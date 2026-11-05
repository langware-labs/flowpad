"""A hub failure during publish/deploy reaches the person as the hub's own reason and status.

The incident: the hub answered 409 "Asset already belongs to a different Project" and the deploy
said "the hub could not register it — try again shortly" (502). Retrying a refusal never helps.
"""

from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.dependencies.resolve import hub_reason


def test_hub_refusal_keeps_its_reason_and_status_and_never_says_retry():
    hub = HubError(409, "Asset already belongs to a different Project")
    err = AssetPublishError.from_hub(hub, "The hub refused to register this asset", data={"rel_path": "a"})

    assert err.code is AssetPublishCode.HUB_REJECTED
    assert err.status_code == 409
    assert "Asset already belongs to a different Project" in err.actionable
    assert "try again shortly" not in err.actionable
    assert err.data["rel_path"] == "a" and err.data["hub_status"] == 409


def test_hub_outage_is_a_502_that_says_retry():
    for hub in (HubError(0, "ReadTimeout"), HubError(503, "HTTP 503 Service Unavailable")):
        err = AssetPublishError.from_hub(hub, "The hub refused to register this asset")
        assert err.code is AssetPublishCode.HUB_PUBLISH_FAILED
        assert err.status_code == 502
        assert "try again shortly" in err.actionable


def test_hub_refusal_as_action_answer_keeps_status_and_reason():
    answer = HubError(403, "You hold no role on this project").fail_response("Could not share")
    assert answer.status_code == 403
    assert "You hold no role on this project" in answer.message


def test_dependency_reason_falls_back_to_what_the_hub_said():
    assert hub_reason(409, "Asset already belongs to a different Project") == (
        "Asset already belongs to a different Project"
    )
    assert hub_reason(404, "whatever") == "nothing on this machine or on the hub has this id"
