"""Publishing an agent to the hub — fields only, id verbatim, once."""

from flow_sdk.builtin.agent import Agent


async def test_publish_is_idempotent(monkeypatch):
    """A second deploy must not re-publish.

    `share()` deliberately does not save, so persisting `remote` is the caller's
    job — forgetting it means every deploy re-POSTs the agent.
    """
    calls: list[int] = []

    async def _share(self, *a, **k):
        calls.append(1)

    async def _save(self, *a, **k):
        return self

    monkeypatch.setattr(Agent, "share", _share, raising=False)
    monkeypatch.setattr(Agent, "save", _save, raising=False)

    agent = Agent(name="joe")
    assert await agent.ensure_on_hub() is True
    assert agent.remote is True
    # second call is a no-op
    assert await agent.ensure_on_hub() is False
    assert calls == [1]


def test_local_path_never_travels_to_the_hub():
    """`asset_ref` is an absolute path on THIS machine.

    It is Sharing.PRIVATE precisely so publishing cannot leak it; the hub has no
    such field and renders its own agent.md from the fields it receives.
    """
    excluded = Agent.fields_not_sent_to_hub()
    assert "asset_ref" in excluded


def test_the_launch_bundle_does_travel():
    """Publishing is worthless if the persona and model stay behind."""
    excluded = set(Agent.fields_not_sent_to_hub())
    for field in ("system_prompt", "avatar", "model", "worker_type", "permission_mode"):
        assert field not in excluded, f"{field} must reach the hub"
