"""``flow diagnose <request id>``: the order a request run does things in, and what each turn is told.

The supporter receives the recorded diagnosis and the files in ``to-send/`` -- nothing the agent
prints on the runner's machine. A run once answered "print the attached file" by printing it to
the runner's own terminal and recording a healthy sweep: under "approve all" the steps rode last in
the ONE diagnosis prompt, as "part of the diagnosis", and the agent ran the skill instead. Now the
steps always run first, each a turn of its own, and every turn knows where its answer must land.
"""

from pathlib import Path

import pytest

from flow_sdk.cli.commands import diagnose_cmd
from flow_sdk.cli.commands.diagnose_cmd import _STEP_PROMPT, _request_context, _request_prompt_extra

OUT = Path("/tmp/run/to-send")
STEPS = ("check where git is", "print the attached file")
SKILL = {"kind": "skills", "name": "rca.zip", "installed_as": "rca", "dir": "/tmp/run/.claude/skills/rca"}
FILE = {"kind": "files", "name": "a.txt", "path": "/tmp/run/from-supporter/a.txt"}


def test_every_turn_knows_what_was_sent_and_that_only_the_to_send_files_reach_the_supporter():
    text = _request_context(OUT, [SKILL, FILE])

    assert "rca (at /tmp/run/.claude/skills/rca)" in text and "/tmp/run/from-supporter/a.txt" in text
    assert f"files in {OUT}" in text and "nothing you print" in text


def test_a_step_turn_writes_its_answer_to_its_own_file_and_carries_the_attachments():
    context = _request_context(OUT, [FILE])

    prompt = _STEP_PROMPT.format(n=2, step=STEPS[1], out=OUT / "step-2.txt", context=context)

    assert f"{OUT}/step-2.txt" in prompt and "Step 2: print the attached file" in prompt
    assert "/tmp/run/from-supporter/a.txt" in prompt, "a step that names an attachment must find it"


def test_the_diagnosis_turn_does_not_repeat_the_steps_it_only_asks_for_their_results():
    text = _request_prompt_extra(STEPS, OUT, [])

    assert "check where git is" not in text, "the steps already ran as their own turns"
    assert f"{OUT}/step-<n>.txt" in text


@pytest.mark.parametrize("choice", ["a", "e"])
async def test_the_steps_run_before_the_diagnosis_whichever_way_they_were_approved(choice, monkeypatch, tmp_path):
    brief = {"open": True, "instructions": "\n".join(STEPS), "attachments": [], "max_run_bytes": 1024}
    answers = iter([choice, "", "", "", "n"])  # approve mode, each step (Y), the issue text, then "don't send"
    seen = {}

    async def hub(method, kind, rid, action, *a, **k):
        return brief

    async def run_diagnose(text, timeout, *, steps=(), approve=None, prompt_extra="", emit=None, **kw):
        seen["steps"] = [s for s in steps if approve is None or approve(s)]
        seen["extra"] = prompt_extra
        return 1  # stop before the result is loaded -- the order is what is under test

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_anonymous_request", hub)
    monkeypatch.setattr(diagnose_cmd, "_ask", lambda q, **_: next(answers))
    monkeypatch.setattr(diagnose_cmd, "_run_diagnose", run_diagnose)

    await diagnose_cmd._run_request("e474595b-470a-4682-adaa-8bcfe8907038", 1.0)

    assert seen["steps"] == list(STEPS), "the supporter's steps run as turns of their own, first"
    assert "check where git is" not in seen["extra"]


async def test_stopping_the_diagnose_worker_ends_its_headless_turn():
    """A headless turn outliving the run left its CLI child holding the run's temp folder and its
    DB writes to be torn down by asyncio.run's exit cleanup -- the Windows traceback burst."""
    import asyncio

    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess, register_prompt_task
    from flow_sdk.cli.commands.diagnose_cmd import _stop_worker

    ap = AgenticProcess(name="flow diagnose")
    turn = asyncio.create_task(asyncio.Event().wait())  # a turn still waiting on its worker
    register_prompt_task(str(ap.id), turn)

    await _stop_worker(ap)

    assert turn.done(), "the run must not end with its agent's turn still running"


def test_a_request_run_is_told_what_was_sent_is_not_a_licence_to_change_files(tmp_path):
    """On the VM the agent copied a supporter's reference file over the user's own config, against
    the sent skill's own "Do not change the file"."""
    from flow_sdk.cli.commands.diagnose_cmd import _request_context

    text = _request_context(tmp_path / "to-send", [{"path": str(tmp_path / "ref.txt")}])

    assert "never edit or delete a file outside Flowpad's own runtime state" in text
    assert "say to leave alone" in text
