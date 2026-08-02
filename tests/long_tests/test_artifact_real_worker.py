"""Long test: a REAL worker running `flow artifact` produces the artifact chip.

The whole artifact model rests on one assumption — that when an agent runs
``flow artifact ...``, the call comes back through the stream as a
``FlowCommandEntry`` the UI can turn into a chip. Every unit test proves that
against a hand-built entry; this proves it against what the vendor binaries
actually emit, on all three harnesses.

No backend is required and none is started. The CLI call itself will fail
(exit 5, nothing listening) — that is irrelevant here and deliberately so: what
is under test is the *transcript*, i.e. that the shell invocation is captured,
parsed, and derived into an artifact chip. Decoupling it from a live server is
what keeps this a fast, hermetic cross-worker check rather than an E2E.

Staged assertions, same discipline as ``test_cli_driver_binary_smoke``: an
environment gap (no auth, no binary, model refused the instruction) SKIPS; only
a real derivation failure fails.

NOTE: requires the vendor CLI installed with valid auth (skips otherwise), and
this module must stay listed in ``conftest._REAL_HOME_TEST_MODULES`` or its
subprocesses get the sandbox HOME and every turn fails "not logged in".
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.codex import CodexAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import CopilotAgentOptions
from flow_sdk.transcript_analyzer import AgentTranscriptFile
from flow_sdk.transcript_analyzer.entries import FlowCommandEntry
from tests.long_tests._model_tier import small_model_for
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

# Strictly below the 30s pytest cap so a hang fails here rather than being
# masked by a slow path. Do not raise it to make a slow turn pass.
_TURN_GUARD_SECONDS = 25

_TARGET = "/tmp/artifact-long/report.html"
_INSTRUCTION = (
    "Run exactly this one shell command and then stop, without commentary: "
    f"flow artifact file {_TARGET}\n"
    "Ignore whatever it prints or whether it fails — just run it once."
)


def _worker(name: str, options_cls, **extra):
    return pytest.param(
        name,
        options_cls,
        extra,
        marks=pytest.mark.skipif(
            shutil.which(name if name != "claude" else "claude") is None,
            reason=f"{name} CLI not installed",
        ),
        id=name,
    )


WORKERS = [
    # Claude only emits a machine-readable stream when explicitly asked; codex
    # and copilot already default to JSON. Without these the parser sees prose
    # and yields zero entries, which would skip forever rather than test.
    _worker("claude", ClaudeAgentOptions, print_mode=True, output_format="stream-json", verbose=True),
    _worker("codex", CodexAgentOptions),
    _worker("copilot", CopilotAgentOptions),
]


def _run_turn(worker: str, options, tmp_path: Path) -> str:
    """One headless turn, returning raw stdout (skips on an environment gap)."""
    workdir = tmp_path / "work"
    workdir.mkdir(parents=True, exist_ok=True)

    argv, _env = options.to_spawn_args()
    binary = shutil.which(argv[0])
    assert binary is not None, f"{worker}: {argv[0]} vanished between skip-check and spawn"

    try:
        result = subprocess.run(
            [binary, *argv[1:]],
            input=_INSTRUCTION,
            capture_output=True,
            text=True,
            cwd=str(workdir),
            timeout=_TURN_GUARD_SECONDS,
        )
    except subprocess.TimeoutExpired:
        # An external model that never came back is infra, not a derivation
        # bug. Classified as a skip — NOT worked around by widening the guard,
        # which would only hide a genuinely stalling path later.
        pytest.skip(f"{worker} turn exceeded {_TURN_GUARD_SECONDS}s — external API/infra")
    if not result.stdout.strip():
        pytest.skip(f"{worker} CLI could not run a turn (auth/env): {result.stderr[:400]}")
    return result.stdout


def _parse(worker: str, stdout: str) -> AgentTranscriptFile:
    artifact_dir = Path(tempfile.mkdtemp())
    transcript = artifact_dir / f"{worker}_live.jsonl"
    transcript.write_text(stdout, encoding="utf-8")
    return AgentTranscriptFile(worker, transcript)


#: Entry kinds a shell invocation can legitimately arrive as. ``flow_command``
#: is the derived refinement — its presence is the thing under test; the other
#: two are what a NON-derived call would look like.
_SHELLISH = {"shell_command", "tool_use", "flow_command"}


def _shell_entries(parsed: AgentTranscriptFile) -> list:
    return [e for e in parsed.entries if e.kind.value in _SHELLISH]


def _issued_the_command(parsed: AgentTranscriptFile) -> bool:
    """Did the model really invoke it, as a tool call?

    Deliberately NOT a substring check on stdout: the instruction text is echoed
    back on several harnesses, and a turn that errored out still contains the
    phrase — which would turn an environment failure into a bogus assertion
    about derivation.
    """
    for entry in _shell_entries(parsed):
        command = getattr(entry, "command", None)
        tool_input = getattr(entry, "tool_input", None)
        haystack = f"{command!r} {tool_input!r}"
        if "flow artifact" in haystack:
            return True
    return False


@pytest.mark.parametrize("worker, options_cls, extra", WORKERS)
@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_real_worker_flow_artifact_derives_a_chip(worker, options_cls, extra, tmp_path: Path):
    """The cross-worker guarantee: one CLI string, one artifact chip, every harness."""
    options = options_cls(workdir=str(tmp_path / "work"), model=small_model_for(worker), **extra)
    parsed = _parse(worker, _run_turn(worker, options, tmp_path))

    if not _issued_the_command(parsed):
        pytest.skip(
            f"{worker} never issued the command in this env (turn failed or model declined) — "
            f"nothing to derive. entry kinds: {sorted({e.kind.value for e in parsed.entries})}"
        )

    flow_commands = [e for e in parsed.entries if isinstance(e, FlowCommandEntry)]

    assert flow_commands, (
        f"{worker} ran `flow artifact` but the transcript derived no FlowCommandEntry — "
        "the chip would silently degrade to a generic shell row. "
        f"entry kinds seen: {sorted({e.kind.value for e in parsed.entries})}"
    )
    artifact_calls = [e for e in flow_commands if e.verb == "artifact"]
    assert artifact_calls, (
        f"{worker} derived flow commands but none with verb 'artifact': {[(e.verb, e.subverb) for e in flow_commands]}"
    )
    assert artifact_calls[0].subverb == "file"
    assert artifact_calls[0].target == _TARGET

    # ...and the frame the UI actually renders off that entry. Asserted in the
    # SAME turn deliberately: a second live run is a second sample of a
    # nondeterministic model, so splitting these would let one pass and its twin
    # fail for reasons that have nothing to do with the code.
    frames = [
        fd
        for entry in parsed.entries
        for fd in entry.to_flow_data()
        if (fd.attributes or {}).get("flow-verb") == "artifact"
    ]

    assert frames, f"{worker}: entry derived but no FlowData frame carried flow-verb=artifact"
    assert frames[0].attributes["flow-subverb"] == "file"
    assert frames[0].attributes["flow-target"] == _TARGET
