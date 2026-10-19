"""A decision API that will not answer says why, in its own words -- what an eval report prints."""

from flow_sdk.decision import failure_detail
from flow_sdk.external_apis.decision.errors import reason_for_status


def test_an_account_out_of_credit_is_billing_not_a_vague_unavailable():
    assert reason_for_status(402) == "billing"
    assert (reason_for_status(429), reason_for_status(503), reason_for_status(500)) == ("rate_limited", "no_endpoint", "unavailable")


def test_the_vendors_own_sentence_is_kept_however_the_hub_wraps_it():
    vendor = {"detail": {"error_type": "billing_error", "message": "Your organization has no available credits."}}
    assert failure_detail(vendor) == "Your organization has no available credits."
    assert failure_detail({"error": "rate_limited", "message": "limit exceeded"}) == "limit exceeded"
    assert failure_detail({"detail": "Not found"}) == "Not found"
    assert failure_detail(None) is None
