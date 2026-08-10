"""Unit tests for ``ensure_launchable`` — the launch pre-flight.

The helper runs two checks with very different costs: ``is_installed`` is a
lookup in the discovery dict, while ``is_logged_in`` shells out to the vendor CLI
(``claude auth status`` / ``codex login status``), uncached, per call.
``createProcess`` gates every new session on this helper, so it asks for the
install check alone — these tests pin that the keyword really skips the probe,
and that the default still behaves as the two pre-existing callers expect.
"""

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import (
    WorkerAuthResult,
    WorkerAuthStatus,
)
from flow_sdk.builtin.agentic_process.launch_health import (
    LaunchErrorCode,
    LaunchHealth,
    ensure_launchable,
)


@pytest.mark.asyncio
async def test_install_only_never_probes_login():
    """``check_auth=False`` must not shell out. This is the whole reason the
    keyword exists: a subprocess probe on every session create would tax the
    happy path to catch a rarer failure."""
    installed = AsyncMock(return_value=True)
    logged_in = AsyncMock()

    with patch.object(AgenticProcess, "is_installed", installed), \
         patch.object(AgenticProcess, "is_logged_in", logged_in):
        assert await ensure_launchable("codex", check_auth=False) is None

    installed.assert_awaited_once()
    logged_in.assert_not_awaited()


@pytest.mark.asyncio
async def test_install_only_still_reports_a_missing_harness():
    """Skipping the login probe must not skip the install verdict — that verdict
    is the one thing the create path is gating on."""
    with patch.object(AgenticProcess, "is_installed", AsyncMock(return_value=False)):
        problem = await ensure_launchable("codex", check_auth=False)

    assert problem is not None
    assert problem.code is LaunchErrorCode.NOT_INSTALLED
    # CONFIG_ERROR is the "needs a human" latch — what makes this a 4xx.
    assert problem.health is LaunchHealth.CONFIG_ERROR
    assert problem.worker_type == "codex"


@pytest.mark.asyncio
async def test_default_still_consults_the_login_probe():
    """Regression guard for the two callers that pass no keyword
    (``ingest/drivers/agent.py``, ``inbox/outbound.py``): the probe must still be
    awaited. Whether its verdict is *honoured* is a separate defect — see below."""
    logged_in = AsyncMock(
        return_value=WorkerAuthResult(status=WorkerAuthStatus.LOGGED_IN, message="ok")
    )

    with patch.object(AgenticProcess, "is_installed", AsyncMock(return_value=True)), \
         patch.object(AgenticProcess, "is_logged_in", logged_in):
        assert await ensure_launchable("codex") is None

    logged_in.assert_awaited_once()


@pytest.mark.xfail(
    strict=True,
    reason=(
        "LaunchError.from_auth compares str(auth.status) against 'logged_out', but "
        "WorkerAuthStatus is a (str, Enum) whose str() is 'WorkerAuthStatus.LOGGED_OUT'. "
        "Every probe constructs WorkerAuthResult with the enum member, so from_auth "
        "always returns None and the auth half of ensure_launchable is dead. Compare "
        "auth.status.value (as WorkerAuthResult.to_json already does). Pre-existing; "
        "createProcess is unaffected because it passes check_auth=False. Remove this "
        "marker when from_auth is fixed."
    ),
)
@pytest.mark.asyncio
async def test_a_logged_out_harness_is_reported():
    logged_out = WorkerAuthResult(status=WorkerAuthStatus.LOGGED_OUT, message="signed out")

    with patch.object(AgenticProcess, "is_installed", AsyncMock(return_value=True)), \
         patch.object(AgenticProcess, "is_logged_in", AsyncMock(return_value=logged_out)):
        problem = await ensure_launchable("codex")

    assert problem is not None
    assert problem.code is LaunchErrorCode.NOT_AUTHENTICATED
