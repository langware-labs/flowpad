"""Real-binary smoke for the codex + copilot CLI drivers.

Purpose: make **fixture drift detectable**. The unit parser tests
(``tests/unit/test_transcript_analyzer/``) run against checked-in JSONL
fixtures; if a vendor changes its ``--json`` event schema, those fixtures go
stale silently. This smoke spawns the REAL binary in the same headless argv
shape production uses (``…CliOptions.to_spawn_args``), runs one trivial turn,
and feeds the live stdout through our parser — so a schema change surfaces as
an ``UnknownEntry`` here.

Doubly gated — skips cleanly unless BOTH hold:
  - ``DEEP_TESTING`` is enabled (``tests.test_settings.test_service_config``)
  - the vendor binary is on ``PATH`` (``shutil.which``)

We spawn the binary directly (not via ``…CLIStreamWorker``) because the worker
resolves its executable through the backend's discovered harness capability,
which isn't populated in a bare pytest process — ``shutil.which`` + the
production argv is the self-contained equivalent.

Run:

    DEEP_TESTING=1 uv run pytest tests/long_tests/test_cli_driver_binary_smoke.py -v -s
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.codex import CodexCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import CopilotCliOptions
from flow_sdk.transcript_analyzer import AgentTranscriptFile
from flow_sdk.transcript_analyzer.entries import UnknownEntry
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

# A guard timeout STRICTLY BELOW the 30s pytest cap: it fails the test on a
# hang rather than masking a slow path (the trivial "say ok" turn must finish
# well inside this). Do not raise it to make a slow turn pass — a slow turn is
# the signal, not the noise.
_TURN_GUARD_SECONDS = 25


def _run_turn_and_parse(worker: str, options, tmp_path: Path, *, success_types: set[str]) -> None:
    """Spawn ``worker`` headless for one trivial turn and parse its live stdout.

    The binary runs in its own throwaway ``work/`` subdir (codex ``--ephemeral``
    scrubs its whole cwd tree on exit), while the parsed-transcript artifact is
    written to a SEPARATE temp dir outside ``tmp_path`` so it survives the run.

    Assertions are staged by how far the turn got, so an environment gap never
    masquerades as fixture drift:
      - **no stdout** (not logged in / offline) → skip.
      - **stdout present**: every line must be valid JSON and the parser must
        recover a session id — this proves the top-level ``--json`` stream shape
        and the session-identity event still match our parser regardless of turn
        outcome.
      - **turn actually completed** (a ``success_types`` terminal event present)
        → additionally assert ZERO ``UnknownEntry``: on a clean happy path, a new
        unmodelled event type is real fixture/schema drift. (A turn that *errors*
        out in this env legitimately emits error-path events our parser doesn't
        model — out of scope here — so we don't fail on those.)
    """
    import json

    workdir = tmp_path / "work"
    workdir.mkdir(parents=True, exist_ok=True)
    argv, _env = options.to_spawn_args()
    binary = shutil.which(argv[0])
    assert binary is not None

    result = subprocess.run(
        [binary, *argv[1:]],
        input="say ok",
        capture_output=True,
        text=True,
        cwd=str(workdir),
        timeout=_TURN_GUARD_SECONDS,
    )
    if not result.stdout.strip():
        pytest.skip(f"{worker} CLI could not run a turn (auth/env): {result.stderr[:400]}")

    # Every non-blank stdout line must be a JSON object — the ``--json`` contract.
    raw_types: set[str] = set()
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)  # raises if the stream stopped being JSON
        if isinstance(obj, dict) and obj.get("type"):
            raw_types.add(str(obj["type"]))

    artifact_dir = Path(tempfile.mkdtemp())
    transcript = artifact_dir / f"{worker}_live.jsonl"
    transcript.write_text(result.stdout, encoding="utf-8")
    parsed = AgentTranscriptFile(worker, transcript)

    assert parsed.session_id, (
        f"{worker} live stream carried no parseable session id — the "
        f"session-identity event shape likely drifted (types seen: {sorted(raw_types)})"
    )

    if not (raw_types & success_types):
        pytest.skip(
            f"{worker} turn did not complete cleanly in this env "
            f"(types seen: {sorted(raw_types)}); stderr={result.stderr[:200]}"
        )

    unknowns = [e for e in parsed.entries if isinstance(e, UnknownEntry)]
    assert not unknowns, (
        f"{worker} completed a turn but emitted event types our parser does not "
        f"recognise — the checked-in fixtures are likely stale: "
        f"{[e.raw_data for e in unknowns]}"
    )


# Per-binary: (worker, options_cls, success terminal-event types). Each carries a
# ``shutil.which`` skip so an uninstalled binary is skipped, not failed — this
# stacks on the module-level DEEP_TESTING gate.
_codex = pytest.param(
    "codex", CodexCliOptions, {"turn.completed"},
    marks=pytest.mark.skipif(shutil.which("codex") is None, reason="codex CLI not installed"),
    id="codex",
)
_copilot = pytest.param(
    "copilot", CopilotCliOptions, {"result"},
    marks=pytest.mark.skipif(shutil.which("copilot") is None, reason="copilot CLI not installed"),
    id="copilot",
)


@pytest.mark.parametrize("worker, options_cls, success_types", [_codex, _copilot])
@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_version_smoke(worker, options_cls, success_types):
    binary = shutil.which(worker)
    result = subprocess.run(
        [binary, "--version"], capture_output=True, text=True, timeout=_TURN_GUARD_SECONDS
    )
    assert result.returncode == 0
    assert any(ch.isdigit() for ch in result.stdout)


@pytest.mark.parametrize("worker, options_cls, success_types", [_codex, _copilot])
@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_headless_turn_parses(worker, options_cls, success_types, tmp_path: Path):
    _run_turn_and_parse(
        worker,
        options_cls(workdir=str(tmp_path / "work")),
        tmp_path,
        success_types=success_types,
    )
