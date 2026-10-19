"""The voice agent's turn, stubbed: what a voice test needs of the agent without a worker."""
from __future__ import annotations

from flow_sdk.builtin.agent_serve import TurnEngine


class Asked:
    """What the stubbed agent was asked: each turn's body, and the session it ran in."""

    def __init__(self):
        self.bodies: list[str] = []
        self.sessions: list[str] = []


def stub_the_turn(monkeypatch, nonce: str) -> Asked:
    """The agent is a stub answering with the nonce."""
    from flow_sdk.schema.data_spec.returned_value_spec import PromptResult  # noqa: PLC0415

    asked = Asked()

    class _Process:
        id = "p-voice"
        typeid = "agentic_process-p-voice"

        def __init__(self):
            self.context_data: dict = {}

        async def send_turn(self, body):
            asked.bodies.append(body)
            return PromptResult.satisfied("The turn was accepted.", executor=self.typeid)

        async def save(self):
            pass

        def fetch_worker_status(self):
            """How the worker ended — the engine reads it the way AgenticProcess.run does. It idles."""
            from flow_sdk.transcript_analyzer.worker_status import WorkerStatus  # noqa: PLC0415

            return WorkerStatus.IDLE

    process = _Process()

    async def process_for(self, session, *_a, **_k):
        asked.sessions.append(session)
        return process

    async def capture(_ap):
        return f"You have two meetings {nonce}."

    monkeypatch.setattr(TurnEngine, "process_for", process_for)
    monkeypatch.setattr("flow_sdk.app.actions.execute_prompt._capture_assistant_reply", capture)
    return asked
