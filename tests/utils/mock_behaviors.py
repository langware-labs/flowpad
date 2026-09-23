"""Stock MockWorker behaviors — a Chief of Staff and a task owner that act the way the instructions
tell a real model to, through the real ``flow`` CLI — plus the in-process runner that CLI goes through.

Data-driven so a test composes a case without new code:

* :func:`chief_of_staff` reads prompt markers — ``[quick]`` answer now, ``[short]`` a native subagent
  (or, on a harness that cannot spawn, a task), ``[long]`` a task — and acts on task news
  (``[task <id> · done …]`` → tell the person on their channel, ``asked`` → answer or relay).
* :func:`task_owner` plays a script of ledger moves as the subagent that owns a task.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Optional

from tests.utils.mock_worker import MockTurn

_TASK_NEWS = re.compile(r"^\[task (?P<id>[0-9a-f-]{36}) · (?P<event>\w+) · by (?P<author>[^\]]+)\]", re.M)


def flow_runner(client, monkeypatch):
    """``flow(process, argv)`` — the real typer CLI, in-process, as ``process`` (FLOWPAD_EXECUTION_SCOPE),
    its HTTP bridged into the in-process app (the ``CliDriver`` pattern of the source matrix)."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from flow_sdk.cli import flow_cli  # noqa: PLC0415
    from flow_sdk.cli.commands import _common, conversation_cmd, task_cmd  # noqa: PLC0415

    loop = asyncio.get_running_loop()

    def request(method, url, json=None, params=None, timeout=None, **_kw):  # noqa: A002
        path = "/" + url.split("://", 1)[1].split("/", 1)[1]
        query = {k: v for k, v in (params or {}).items() if v not in (None, "", False)}
        return asyncio.run_coroutine_threadsafe(client.request(method, path, json=json, params=query), loop).result()

    for module in (_common, task_cmd):
        monkeypatch.setattr(module, "local_request", request)
        monkeypatch.setattr(module, "discover_port", lambda *a, **k: 1)
    monkeypatch.setattr(conversation_cmd, "_discover_port", lambda *a, **k: 1)

    # CliRunner sets its env on the PROCESS: two turns calling at once (a chief and a run) would
    # borrow each other's identity — one call at a time.
    lock = asyncio.Lock()

    async def run(process, argv: list[str]) -> dict:
        env = {"FLOWPAD_EXECUTION_SCOPE": json.dumps([{"type": "agentic_process", "id": process.id}])}
        async with lock:
            result = await asyncio.to_thread(CliRunner().invoke, flow_cli.app, argv, env=env)
        lines = [ln for ln in (result.stdout + "\n" + (result.stderr if hasattr(result, "stderr") else "")).splitlines() if ln.startswith("{")]
        payload = json.loads(lines[-1]) if lines else {"ok": False, "error": result.output[-400:]}
        return {"exit_code": result.exit_code, **payload}

    return run


def task_news(prompt: str) -> Optional[dict]:
    """``{id, event, author}`` when the prompt is task news, else ``None``."""
    m = _TASK_NEWS.search(prompt or "")
    return m.groupdict() if m else None


def chief_of_staff(*, owner: str = "subagent:general-worker", native: str = "general-worker", relay_questions: bool = True):
    """A Chief of Staff that follows CoS.md."""

    async def behavior(turn: MockTurn) -> str:
        prompt = turn.prompt
        if not turn.is_chief_of_staff:
            # What a model does when nobody told it it is a Chief of Staff: it just answers.
            return f"Plain answer: {prompt[:60]}"
        news = task_news(prompt)
        if news is not None:
            show = (await turn.flow("task", "show", news["id"]))["task"]
            origin = show.get("origin_conversation") or ""
            if news["event"] == "done":
                if origin:
                    await turn.flow("conversation", "reply", origin, f"Done: {show.get('result')}")
                return "relayed the result"
            if news["event"] == "asked":
                question = show["log"][-1]["text"]
                if relay_questions and origin:
                    await turn.flow("conversation", "reply", origin, f"A question from the team: {question}")
                    return "relayed the question"
                await turn.flow("task", "reply", news["id"], "Use your best judgement.")
                return "answered the owner"
            if news["event"] in ("failed", "stalled"):
                if origin:
                    await turn.flow("conversation", "reply", origin, f"Heads-up: the task {news['event']}.")
                return f"told the person it {news['event']}"
            return "noted"
        answer = _pending_answer(prompt)
        if answer is not None:
            open_ = (await turn.flow("task", "list"))["tasks"]
            waiting = [t for t in open_ if t["status"] == "input_required"]
            if waiting:
                await turn.flow("task", "reply", waiting[0]["id"], answer)
                return "Thanks — passed that on."
        if "[quick]" in prompt:
            return "Quick answer: 42."
        if "[short]" in prompt:
            if turn.spawns_subagents:
                found = turn.native_subagent(native, "Look this up", "It is 17.")
                return f"Checked: {found}"
            created = await turn.flow("task", "create", "--title", _title(prompt), "--brief", prompt, "--owner", owner)
            return f"Started task {created['task']['id']} — I'll get back to you."
        if "[long]" in prompt:
            created = await turn.flow("task", "create", "--title", _title(prompt), "--brief", prompt, "--owner", owner)
            return f"Started task {created['task']['id']} — I'll get back to you."
        return "Hello."

    return behavior


def task_owner(*, result: str = "The summary is written.", ask: str = "", notes: tuple[str, ...] = ("halfway",)):
    """The subagent that owns a task: start → notes → (ask, then wait) → done."""

    async def behavior(turn: MockTurn) -> str:
        task_id = turn.owned_task_id
        news = task_news(turn.prompt)
        if news is not None and news["event"] == "canceled":
            return "stopping"
        if news is not None and news["event"] == "replied":
            await turn.flow("task", "done", task_id, "--result", f"{result} (with: {turn.prompt.splitlines()[-1]})")
            return "done after the answer"
        assert task_id in turn.prompt and ("[long]" in turn.prompt or "[short]" in turn.prompt), \
            f"a run starts from its brief: {turn.prompt[:200]!r}"
        await turn.flow("task", "start", task_id)
        for note in notes:
            await turn.flow("task", "note", task_id, note)
        if ask:
            await turn.flow("task", "ask", task_id, ask)
            return "waiting for an answer"
        await turn.flow("task", "done", task_id, "--result", result)
        return "done"

    return behavior


def both(chief, owner):
    """One driver for the whole flow: the owner's behavior on a task run, the chief's on anything else."""

    async def behavior(turn: MockTurn) -> Any:
        return await (owner if turn.owned_task_id else chief)(turn)

    return behavior


def _title(prompt: str) -> str:
    words = re.sub(r"\[\w+\]", "", prompt).strip().split()
    return " ".join(words[:6]) or "task"


def _pending_answer(prompt: str) -> Optional[str]:
    m = re.search(r"\[answer\]\s*(.+)", prompt or "")
    return m.group(1).strip() if m else None


__all__ = ["both", "chief_of_staff", "flow_runner", "task_news", "task_owner"]
