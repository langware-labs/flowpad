import pytest

from flow_sdk.cloud_client.error_reporter import _HubErrorReporter


@pytest.mark.asyncio
async def test_error_reporter_suppresses_and_emits_summary():
    now = 100.0
    messages = []

    def clock():
        return now

    async def broadcast(message):
        messages.append(message)

    reporter = _HubErrorReporter(
        max_per_window=10,
        window_seconds=60.0,
        clock=clock,
        broadcast_func=broadcast,
    )

    for _ in range(11):
        await reporter.report(status_code=500, method="GET", path="/x", message="boom")

    assert len(messages) == 10
    assert all(msg.suppressed_count == 0 for msg in messages)

    now = 161.0
    await reporter.report(status_code=503, method="POST", path="/y", message="down")

    assert len(messages) == 12
    assert messages[-2].suppressed_count == 1
    assert "suppressed" in messages[-2].message
    assert messages[-1].status_code == 503
    assert messages[-1].path == "/y"


@pytest.mark.asyncio
async def test_only_a_failed_request_that_is_answered_again_clears_its_error():
    messages = []

    async def broadcast(message):
        messages.append(message)

    reporter = _HubErrorReporter(broadcast_func=broadcast)

    await reporter.recovered(method="GET", path="/x")
    assert messages == [], "nothing failed, so nothing recovers"

    await reporter.report(status_code=0, method="GET", path="/x", message="timed out")
    await reporter.report(status_code=502, method="GET", path="/y", message="bad gateway")
    await reporter.recovered(method="GET", path="/x")
    await reporter.recovered(method="GET", path="/x")

    recovered = [m for m in messages if m.message_type == "hub_client_recovered_msg"]
    assert [(m.method, m.path) for m in recovered] == [("GET", "/x")], (
        "/x was answered once after failing; /y never was, so its error stays"
    )


@pytest.mark.asyncio
async def test_repeats_of_one_call_carry_first_last_and_count_until_it_recovers():
    messages = []
    wall = iter([1000.0, 1005.0, 1010.0])

    async def broadcast(message):
        messages.append(message)

    reporter = _HubErrorReporter(broadcast_func=broadcast, wall_clock=lambda: next(wall))

    await reporter.report(
        status_code=422, method="GET", path="/issue", message="bad filter", detail={"response": {"body": '{"x":1}'}}
    )
    await reporter.report(status_code=422, method="GET", path="/issue", message="bad filter")
    d = messages[-1].detail
    assert (d["firstAt"], d["lastAt"], d["count"]) == (1_000_000.0, 1_005_000.0, 2)
    assert messages[0].detail["response"]["body"] == '{"x":1}'

    await reporter.recovered(method="GET", path="/issue")
    await reporter.report(status_code=422, method="GET", path="/issue", message="bad filter")
    assert (messages[-1].detail["firstAt"], messages[-1].detail["count"]) == (1_010_000.0, 1), (
        "a recovered call starts a new run"
    )


@pytest.mark.asyncio
async def test_suppressed_errors_are_kept_and_sent_with_the_notice():
    now = 0.0
    messages = []

    async def broadcast(message):
        messages.append(message)

    reporter = _HubErrorReporter(max_per_window=1, window_seconds=60.0, clock=lambda: now, broadcast_func=broadcast)
    await reporter.report(status_code=500, method="GET", path="/a", message="shown")
    await reporter.report(status_code=402, method="POST", path="/b", message="limit hit")
    now = 61.0
    await reporter.report(status_code=500, method="GET", path="/c", message="next")

    notice = messages[1]
    assert notice.suppressed_count == 1
    assert [h["title"] for h in notice.detail["hidden"]] == ["POST /b"]
