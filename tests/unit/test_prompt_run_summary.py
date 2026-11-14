"""The run summary a prompt request's answer carries back: tools and files, nothing else."""

import json

from flow_sdk.schema.data_spec.prompt_run_summary_spec import MAX_STEPS, summarize_last_turn, summary_attachment
from flow_sdk.transcript_analyzer.entries.file_edit import FileEditEntry
from flow_sdk.transcript_analyzer.entries.file_read import FileReadEntry
from flow_sdk.transcript_analyzer.entries.shell_command import ShellCommandEntry
from flow_sdk.transcript_analyzer.entries.user_message import UserMessageEntry

ROOT = "/Users/noa/work/app"
BASE = {"session_id": "s", "timestamp": "2026-11-13T10:00:00Z", "worker": "claude"}


def _user(text: str, *, is_meta: bool = False) -> UserMessageEntry:
    return UserMessageEntry(id=text, text=text, is_meta=is_meta, **BASE)


def _read(i: str, path: str, **kw) -> FileReadEntry:
    return FileReadEntry(id=i, path=path, tool_name="Read", tool_use_id=i, **kw, **BASE)


def _edit(i: str, path: str) -> FileEditEntry:
    return FileEditEntry(id=i, path=path, tool_name="Edit", tool_use_id=i, **BASE)


def test_names_the_last_turns_tools_and_files_and_nothing_they_read_or_printed():
    entries = [
        _user("an earlier prompt"),
        _read("t0", f"{ROOT}/old.py"),
        _user("fix the bug"),
        _read("t1", f"{ROOT}/src/a.py", content_preview="SECRET = 1"),
        _user("<system-reminder>", is_meta=True),  # fed back mid-turn: not a new prompt
        ShellCommandEntry(
            id="t2", command="cat ~/.ssh/id_rsa", stdout_preview="PRIVATE KEY", tool_name="Bash", tool_use_id="t2", **BASE,
        ),
        _edit("t3", f"{ROOT}/src/a.py"),
        _edit("t3", f"{ROOT}/src/a.py"),  # the same step, written twice
        _edit("t4", "/etc/hosts"),
    ]

    summary = summarize_last_turn(entries, root=ROOT)

    assert [(s.tool, s.path) for s in summary.steps] == [
        ("Read", "src/a.py"),
        ("Bash", None),
        ("Edit", "src/a.py"),
        ("Edit", "hosts"),  # outside the run's folder: its name, never where it lives
    ]
    assert summary.files_touched == ["src/a.py", "hosts"]
    wire = summary_attachment("c1", summary)
    assert wire["data"] == "prompt_run_summary-c1"
    for leaked in ("SECRET", "PRIVATE KEY", "id_rsa", "/Users/noa", "/etc"):
        assert leaked not in wire["prompt_preview"]


def test_a_long_run_is_cut_and_says_how_much_is_left_out():
    entries = [_user("go")] + [_read(f"t{i}", f"{ROOT}/f{i}.py") for i in range(MAX_STEPS + 7)]
    summary = summarize_last_turn(entries, root=ROOT)
    assert len(summary.steps) == MAX_STEPS and summary.more == 7
    assert json.loads(summary_attachment("c1", summary)["prompt_preview"])["more"] == 7
