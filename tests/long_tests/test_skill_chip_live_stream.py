"""Long test: the live stream-json converter must emit the skill-body meta frame.

Bug capture (RCA): when a worker invokes a skill, the Claude CLI emits the
framework-injected skill body on stdout as a ``user`` event with a ``text``
content block — the same line the session transcript stamps ``isMeta``. The
UI's "Using skill" chip renders ONLY from a USER_MESSAGE FlowData with
``is-meta="true"`` (the Skill TOOL_CALL/TOOL_RESULT pair is deliberately
dropped client-side in favor of that chip). ``event_to_flowdata`` used to
forward only ``tool_result`` blocks from user events and silently dropped the
text block, so the chip never appeared live — only after a refresh replayed
the on-disk transcript through the (correct) history path.

Faithful reproduction: run the REAL Claude CLI headless with a real project
skill, pipe its real stream-json stdout through the REAL live converter, and
assert the meta user-message frame is present. No mocks.

NOTE: requires Claude Code installed with valid auth (skips otherwise).
"""

import json
import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude import event_to_flowdata
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from tests.test_settings import test_service_config
from tests.utils import find_claude, run_claude

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

SKILL_NAME = "chip-probe"
SKILL_REPLY = "CHIP_PROBE_OK"


def _make_workspace_with_skill(tmp_path: Path) -> Path:
    skill_dir = tmp_path / ".claude" / "skills" / SKILL_NAME
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: {SKILL_NAME}
description: Trivial probe skill. When invoked, reply with exactly {SKILL_REPLY}.
---

Reply with exactly: {SKILL_REPLY}
""",
        encoding="utf-8",
    )
    return tmp_path


def test_live_stream_emits_skill_meta_chip_frame(tmp_path):
    """The live converter must carry the injected skill body as an is-meta
    USER_MESSAGE frame — the frame the "Using skill" chip renders from."""
    if not find_claude():
        pytest.skip("Claude command not found in PATH")

    workdir = _make_workspace_with_skill(tmp_path)

    proc = run_claude(
        workdir,
        prompt=f"Invoke the {SKILL_NAME} skill via the Skill tool and do what it says.",
        extra_args=["--output-format", "stream-json", "--verbose", "--model", "haiku"],
        debug=False,
    )
    try:
        stdout, stderr = proc.communicate(timeout=60)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()

    if "invalid api key" in stdout.lower():
        pytest.skip("Claude authentication required")
    assert stdout, f"Claude produced no output. stderr: {stderr[:500]}"

    # Parse the stream once, then drive every real event through the REAL
    # live converter.
    events = [
        d
        for d in (json.loads(line) for line in stdout.splitlines() if line.strip())
        if isinstance(d, dict)
    ]
    flat = [fd for event in events for fd in event_to_flowdata.convert_event(event)]

    # Precondition: the run really invoked the skill (otherwise a failure
    # below would be about the model, not the converter).
    skill_calls = [
        fd
        for fd in flat
        if fd.attributes.get("element-type") == FlowElementType.TOOL_CALL
        and fd.attributes.get("tool-name") == "Skill"
    ]
    assert skill_calls, (
        "Run never invoked the Skill tool — cannot exercise the bug. "
        f"stdout tail: {stdout[-500:]}"
    )
    # And the CLI really emitted the injected skill body on the raw stream —
    # so an assertion failure below can only mean the converter dropped it.
    assert any(_has_skill_body(d) for d in events), (
        "CLI stream-json did not carry the injected skill body as a user text "
        f"block — vendor stream format drifted? stdout tail: {stdout[-500:]}"
    )

    # THE BUG: the chip's frame — a USER_MESSAGE with is-meta="true" carrying
    # the injected skill body — must be present in the live converted stream.
    meta_frames = [
        fd
        for fd in flat
        if fd.attributes.get("element-type") == FlowElementType.USER_MESSAGE
        and fd.attributes.get("is-meta") == "true"
    ]
    assert meta_frames, (
        "Live stream has no is-meta USER_MESSAGE frame for the skill body — "
        "the 'Using skill' chip cannot render until a refresh replays the "
        "transcript (event_to_flowdata._convert_user_event drops user text blocks)."
    )
    assert any(
        "Base directory for this skill" in str(fd.flow_value) for fd in meta_frames
    ), f"Meta frames present but none carries the skill body: {[str(f.flow_value)[:80] for f in meta_frames]}"


def _has_skill_body(event: dict) -> bool:
    if event.get("type") != "user":
        return False
    content = event.get("message", {}).get("content")
    if not isinstance(content, list):
        return False
    return any(
        isinstance(b, dict)
        and b.get("type") == "text"
        and "Base directory for this skill" in str(b.get("text", ""))
        for b in content
    )
