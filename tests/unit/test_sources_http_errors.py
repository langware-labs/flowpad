"""THE status → error table: what a source says when a provider answers with an error."""
import pytest

from flow_sdk.sources.errors import AccessDenied, NotFound, Rejected, SourceUnavailable
from flow_sdk.sources.http import error_for_status

HINT = "check the address and API key"


@pytest.mark.parametrize("status, kind", [(401, AccessDenied), (403, AccessDenied), (404, NotFound), (400, Rejected)])
def test_a_status_the_caller_can_fix_names_where_to_look(status, kind):
    error = error_for_status(status, HINT)
    assert isinstance(error, kind) and str(error).endswith(HINT)


@pytest.mark.parametrize("status, says", [(429, "limiting how fast"), (503, "the service failed")])
def test_a_rate_limit_or_a_failing_service_is_not_blamed_on_the_address_or_key(status, says):
    error = error_for_status(status, HINT)
    assert isinstance(error, SourceUnavailable)
    assert says in str(error) and HINT not in str(error)


def test_the_services_own_words_are_always_said():
    assert "daily quota used up" in str(error_for_status(429, reason="daily quota used up"))
