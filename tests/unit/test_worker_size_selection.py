"""Size selection at the real resolver/CLI seams traced during the live RCA."""
import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _slug_for, driver_api_auth_spec
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.cli import DeepAgentsAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.cli import OpenCodeAgentOptions
from flow_sdk.schema.data_spec.llm_source_spec import LLMSource

OPTIONS = dict(claude=ClaudeAgentOptions, codex=CodexAgentOptions,
               copilot=CopilotAgentOptions, opencode=OpenCodeAgentOptions,
               deepagents=DeepAgentsAgentOptions)
SIZES = ("sm", "md", "lg")


def _model_flags(argv):
    return tuple(argv[i + 1] for i, flag in enumerate(argv[:-1]) if flag in ("--model", "-m"))


def test_native_sizes_emit_distinct_model_choices():
    choices = {}
    for size in SIZES:
        argv = ClaudeAgentOptions(model=size)._emit_flags()
        choices[size] = _model_flags(argv)
    assert all(choices.values()), f"Size request dropped: {choices}"
    assert len(set(choices.values())) == len(SIZES), choices


@pytest.mark.parametrize("worker", OPTIONS)
def test_distinct_endpoint_sizes_reach_worker_model_flags(worker):
    # Declared endpoint inputs, not a claim about the current budget's tier map.
    tiers = dict(zip(SIZES, ("anthropic/claude-haiku-5.5",
                            "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5")))
    source = LLMSource(endpoint_typeid=f"llm_endpoint-{mint_uuid()}")
    spec = driver_api_auth_spec(worker)
    choices = []
    for size in SIZES:
        selected = _slug_for(worker, spec, tiers, source, size)
        argv = OPTIONS[worker](model=selected, session_id=str(mint_uuid()))._emit_flags()
        emitted = _model_flags(argv)
        assert emitted == (spec.slug_prefix + tiers[size],)
        choices.extend(emitted)
    assert len(set(choices)) == len(SIZES)


@pytest.mark.parametrize("worker", ["codex", "copilot"])
async def test_configured_device_sizes_reach_native_flags(worker):
    """The sizes set on the device login's own endpoint row are what a device spawn runs."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import binding_for_candidate
    from flow_sdk.builtin.agentic_process.cli_drivers.device_endpoints import configure_device
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint
    row = await LLMEndpoint.ensure_device(worker)
    original = dict(row.tiers)
    tiers = dict(zip(SIZES, ("small-model", "medium-model", "large-model")))
    endpoint = LLMEndpoint.device_projection(worker)
    assert endpoint.id == row.id, "the stored row and the picker's device source are one typeid"
    candidate = (endpoint, LLMSource(endpoint_typeid=str(endpoint.typeid)))
    try:
        await configure_device(worker, tiers)
        for tier in SIZES:
            auth = await binding_for_candidate(worker, candidate, tier=tier)
            argv = OPTIONS[worker](model=auth.model_slug)._emit_flags()
            assert _model_flags(argv) == (tiers[tier],)
    finally:
        await configure_device(worker, original)


@pytest.mark.parametrize("worker", ["codex", "copilot"])
async def test_unmapped_device_size_is_refused_before_spawn(worker):
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import binding_for_candidate
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError
    from flow_sdk.builtin.agentic_process.cli_drivers.device_endpoints import configure_device
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint
    row = await LLMEndpoint.ensure_device(worker)
    original = dict(row.tiers)
    endpoint = LLMEndpoint.device_projection(worker)
    candidate = (endpoint, LLMSource(endpoint_typeid=str(endpoint.typeid)))
    try:
        await configure_device(worker, {})
        with pytest.raises(WorkerSpawnError, match="has no device mapping"):
            await binding_for_candidate(worker, candidate, tier="sm")
        assert await binding_for_candidate(worker, candidate) is None
    finally:
        await configure_device(worker, original)
