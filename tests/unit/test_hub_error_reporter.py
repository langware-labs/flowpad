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
