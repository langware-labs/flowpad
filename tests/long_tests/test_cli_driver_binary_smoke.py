"""Real-binary smoke for the codex + copilot + opencode CLI drivers.

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

The harnesses with no vendor login of their own here (opencode, deepagents) run their turn
funded the way a new Flowpad user's box funds them: through a LOCAL hub
(``FLOWPAD_HUB_URL``), signed in as a brand-new user whose default allowance draws on the
hub's Vertex-funded root, bound by the production ``binding_for_candidate``. No provider
key is read or stored.

We spawn the binary directly (not via ``…CLIStreamWorker``) because the worker
resolves its executable through the backend's discovered harness capability,
which isn't populated in a bare pytest process — ``shutil.which`` + the
production argv is the self-contained equivalent.

Run:

    DEEP_TESTING=1 uv run pytest tests/long_tests/test_cli_driver_binary_smoke.py -v -s
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.codex import CodexAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import CopilotAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.cli import DeepAgentsAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.opencode import OpenCodeAgentOptions
from flow_sdk.transcript_analyzer import AgentTranscriptFile
from flow_sdk.transcript_analyzer.entries import UnknownEntry
from tests.long_tests._model_tier import small_model_for
from tests.long_tests.conftest import worker_is_installed
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
    argv, options_env = options.to_spawn_args()
    binary = shutil.which(argv[0])
    assert binary is not None

    result = subprocess.run(
        [binary, *argv[1:]],
        input="say ok",
        capture_output=True,
        text=True,
        cwd=str(workdir),
        # The options' own env rides along: a CLI with a vendor login needs none of it, but a
        # harness funded only by an endpoint (deepagents) has nothing else to spend.
        env={**os.environ, **options_env},
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
    "codex", CodexAgentOptions, {"turn.completed"},
    marks=pytest.mark.skipif(shutil.which("codex") is None, reason="codex CLI not installed"),
    id="codex",
)
_copilot = pytest.param(
    "copilot", CopilotAgentOptions, {"result"},
    marks=pytest.mark.skipif(shutil.which("copilot") is None, reason="copilot CLI not installed"),
    id="copilot",
)
# OpenCode's terminal is ``step_finish`` with ``part.reason == "stop"``; the same
# event with ``reason == "tool-calls"`` is a continuation, not an ending. Its device
# login is signed out under the test HOME, so its turn is funded through the hub
# (``hub_funding``); the hub binding moves only its OpenRouter provider's base URL.
_opencode = pytest.param(
    "opencode", OpenCodeAgentOptions, {"step_finish"},
    marks=pytest.mark.skipif(shutil.which("opencode") is None, reason="opencode CLI not installed"),
    id="opencode",
)


def _deepagents_options(**kwargs) -> DeepAgentsAgentOptions:
    """The runner needs a session id (the driver preassigns one); its funding rides ``env_vars``."""
    from flow_sdk.api.api_types.identifier import mint_uuid

    return DeepAgentsAgentOptions(session_id=mint_uuid(), **kwargs)


# Our own runner over LangChain's deepagents: the stream is OURS, so "drift" here means the
# engine changed the message shapes the runner translates. Its terminal is ``result``.
_deepagents = pytest.param(
    "deepagents", _deepagents_options, {"result"},
    marks=pytest.mark.skipif(not worker_is_installed("deepagents"), reason="deepagents harness not installed"),
    id="deepagents",
)

#: Harnesses with no vendor login to ride in this env: their turn spends the hub allowance.
_HUB_FUNDED = frozenset({"opencode", "deepagents"})


@pytest.fixture
async def hub_funding(worker) -> dict:
    """The options a hub-funded harness spawns with -- ``env_vars``, ``model``, opencode's
    ``provider_options`` -- from the production binding for the box's chosen source; ``{}`` for a
    harness that rides its own vendor login. SKIPs (via ``fund_worker_without_a_login``) when no
    LOCAL hub funds this box."""
    if worker not in _HUB_FUNDED:
        return {}
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import binding_for_candidate
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import list_llm_candidates, pick_llm_candidate
    from flow_sdk.builtin.llm_endpoint import LLMEndpointKind
    from tests.long_tests.conftest import fund_worker_without_a_login

    await fund_worker_without_a_login(worker, even_with_device_login=True)
    chosen = pick_llm_candidate(await list_llm_candidates(worker))
    assert chosen is not None and chosen.endpoint.kind == LLMEndpointKind.HUB, (
        f"{worker}: funded through the hub, yet the box chose {chosen and chosen.endpoint.kind}"
    )
    auth = await binding_for_candidate(worker, (chosen.endpoint, chosen.source), tier="sm")
    assert auth is not None and auth.env, f"{worker}: the hub endpoint produced no spawn binding"
    funding: dict = {"env_vars": dict(auth.env), "model": auth.model_slug}
    if auth.provider_options:
        funding["provider_options"] = dict(auth.provider_options)
    return funding


@pytest.mark.parametrize("worker, options_cls, success_types", [_codex, _copilot, _opencode, _deepagents])
@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_version_smoke(worker, options_cls, success_types):
    # The vendor's own argv head: a name on PATH for a CLI, this interpreter + ``-m`` for a package.
    head = options_cls()._resolve_binary()
    binary = shutil.which(head[0])
    result = subprocess.run(
        [binary, *head[1:], "--version"], capture_output=True, text=True, timeout=_TURN_GUARD_SECONDS
    )
    assert result.returncode == 0
    assert any(ch.isdigit() for ch in result.stdout)


@pytest.mark.parametrize("worker, options_cls, success_types", [_codex, _copilot, _opencode, _deepagents])
@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_headless_turn_parses(worker, options_cls, success_types, hub_funding, tmp_path: Path):
    funding = dict(hub_funding)
    provider_options = funding.pop("provider_options", None)
    funding.setdefault("model", small_model_for(worker))
    options = options_cls(workdir=str(tmp_path / "work"), **funding)
    if provider_options:
        # opencode reads its provider block from the per-process ``opencode.json`` only, which
        # production writes through the assets channel; the smoke has no process, so a fresh id
        # stands in for one -- without it the hub's base URL never reaches the CLI.
        from types import SimpleNamespace

        from flow_sdk.api.api_types.identifier import mint_uuid

        options.provider_options = provider_options
        options.apply_instruction_assets(SimpleNamespace(process_id=mint_uuid(), assets_dir=None))
    _run_turn_and_parse(worker, options, tmp_path, success_types=success_types)
