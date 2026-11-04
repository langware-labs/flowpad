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


# ── the provider's name, and the opt-in rate-limit wait ──
import pickle  # noqa: E402

import httpx  # noqa: E402

from flow_sdk.schema.data_spec.returned_value_spec import CliResult  # noqa: E402
from flow_sdk.sources import http  # noqa: E402


def test_a_source_error_says_it_is_one_and_which_source():
    error = SourceUnavailable("HTTP 429", provider="crm")
    assert str(error) == "Data source error: crm — HTTP 429"
    assert str(SourceUnavailable("HTTP 429")) == "Data source error: HTTP 429"
    again = pickle.loads(pickle.dumps(error))
    assert str(again) == str(error) and again.message == "HTTP 429"


def _client(answers: list[int]) -> httpx.AsyncClient:
    def reply(_request):
        return httpx.Response(answers.pop(0), headers={"retry-after": "0"})
    return httpx.AsyncClient(transport=httpx.MockTransport(reply))


async def test_a_rate_limit_fails_at_once_by_default():
    with pytest.raises(SourceUnavailable, match="HTTP 429"):
        await http.request(_client([429, 200]), "GET", "https://x.test/")


async def test_a_source_that_opts_in_waits_out_the_rate_limit():
    response = await http.request(_client([429, 200]), "GET", "https://x.test/", rate_limit_retries=1)
    assert response.status_code == 200


def test_a_failed_command_keeps_its_last_error_line():
    result = CliResult.of_process("sh x", 1, stderr="INFO: working\nerror: Data source error: crm — HTTP 429\n")
    assert result.detail == "Data source error: crm — HTTP 429"
    assert CliResult.of_process("sh x", 3).detail == "The command exited 3."


async def test_an_error_leaving_a_session_names_the_source():
    from flow_sdk.sources.base import Source
    from flow_sdk.sources.binding import SourceBinding

    class Crm(Source):
        provider = "crm"

    with pytest.raises(SourceUnavailable, match="Data source error: crm — down"):
        async with Crm(SourceBinding()):
            raise SourceUnavailable("down")
