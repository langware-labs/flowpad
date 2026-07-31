"""The run routing seam: a run is addressed to a machine, not to "here"."""
import pytest

from flow_sdk.builtin.agent_deployment import COMPUTE_NODE_LABEL
from flow_sdk.builtin.agent_run import (
    TAG_RUN_FAILED,
    TAG_RUN_REQUESTED,
    TAG_RUN_STARTED,
    dispatch_agent_run,
)


class _FakeDeployment:
    """Minimal stand-in — dispatch only needs addressing + launch."""

    def __init__(self, node_id: str, local: bool, launch=None):
        self.id = "dep-1"
        self.kind = "local.runtime.agent"
        self.parent_type_id = "agent-1"
        self.provider_labels = {COMPUTE_NODE_LABEL: node_id}
        self.compute_node_id = node_id
        self.is_local = local
        self._launch = launch

    async def agent(self):
        return type("A", (), {"name": "probe"})()

    async def launch(self, prompt, **options):
        return await self._launch(prompt, **options)


@pytest.fixture
def captured(monkeypatch):
    """Capture emitted (tag, target) pairs without a live bus."""
    seen: list[tuple[str, str, dict]] = []
    import flow_sdk.builtin.agent_run as mod

    monkeypatch.setattr(mod, "_emit", lambda tag, node, data: seen.append((tag, node, data)))
    return seen


async def test_local_run_launches_and_reports_started(captured):
    async def _launch(prompt, **_):
        return type("P", (), {"id": "proc-9"})()

    dep = _FakeDeployment("local-node", local=True, launch=_launch)
    proc = await dispatch_agent_run(dep, "do the thing")

    assert proc.id == "proc-9"
    tags = [t for t, _n, _d in captured]
    assert tags == [TAG_RUN_REQUESTED, TAG_RUN_STARTED]
    # every event is addressed to the machine the deployment places it on
    assert {n for _t, n, _d in captured} == {"local-node"}
    assert captured[-1][2]["process_id"] == "proc-9"


async def test_remote_run_refuses_rather_than_running_here(captured):
    """The failure mode that matters.

    Silently running a remote deployment on this machine would be invisible in
    the returned process — "it ran in the cloud" would simply be false.
    """
    async def _launch(prompt, **_):  # pragma: no cover - must never be reached
        raise AssertionError("a remote deployment must not launch locally")

    dep = _FakeDeployment("far-away-node", local=False, launch=_launch)

    with pytest.raises(NotImplementedError) as err:
        await dispatch_agent_run(dep, "do the thing")

    assert "far-away-node" in str(err.value)
    assert [t for t, _n, _d in captured] == [TAG_RUN_REQUESTED, TAG_RUN_FAILED]


async def test_launch_failure_is_reported_and_reraised(captured):
    async def _launch(prompt, **_):
        raise RuntimeError("worker died")

    dep = _FakeDeployment("local-node", local=True, launch=_launch)
    with pytest.raises(RuntimeError, match="worker died"):
        await dispatch_agent_run(dep, "x")

    assert [t for t, _n, _d in captured] == [TAG_RUN_REQUESTED, TAG_RUN_FAILED]
    assert captured[-1][2]["error"] == "worker died"
