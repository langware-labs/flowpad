"""Typed boundaries of non-Python blocks, through the runner's external seams."""

import json

import pytest

from flow_sdk.core.compute_op import runner
from flow_sdk.core.compute_op.context import CallContext
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.dock_pointer_spec import DockPointerSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode, NavigateResult, PromptResult
from flow_sdk.schema.data_spec.spec import DataSpec


@pytest.mark.parametrize("text,expected", [("null", ExitCode.OK), ("", ExitCode.NOT_YET), ("[1]", ExitCode.NOT_YET)])
async def test_nullable_output_distinguishes_json_null_from_silence(text, expected):
    async def shell(command, **kwargs):
        return CliResult.of_process(command, 0, text)

    exe = {"commands": {"linux": "answer"}}
    answer = await runner.run_op(ComputeOpSpec(subkind="cli", exe_data=exe, output="?int"),
                                 trusted=True, platform="linux", shell=shell)
    assert answer.exit_code is expected
    assert answer.has_value is (expected is ExitCode.OK)
    assert answer.value is None


@pytest.mark.parametrize("returned,expected", [([1], ExitCode.OK), (["wrong"], ExitCode.NOT_YET), (None, ExitCode.NOT_YET)])
async def test_navigate_validates_output_and_uses_typed_pointer(returned, expected):
    pointer = DockPointerSpec(viewType="web-app", pointer="https://example.com")

    async def navigate(target, **kwargs):
        assert target == pointer
        return NavigateResult.satisfied(value=returned) if returned is not None else NavigateResult.satisfied()

    spec = ComputeOpSpec(subkind="navigate", exe_data={}, input=DockPointerSpec.spec_kind, output=["int"])
    answer = await runner.run_op(spec, input=pointer, trusted=True, navigate=navigate)
    assert answer.exit_code is expected
    assert answer.has_value is (expected is ExitCode.OK)


@pytest.mark.parametrize("explicit_workdir", [False, True])
async def test_agent_typed_input_overrides_legacy_scope_and_uses_effective_workdir(tmp_path, explicit_workdir):
    context_dir = tmp_path / "context"
    override_dir = tmp_path / "override"
    expected_dir = override_dir if explicit_workdir else context_dir
    context = CallContext(asset_folder=tmp_path, workdir=context_dir)

    async def launch(**kwargs):
        assert kwargs["workdir"] == expected_dir
        assert isinstance(kwargs["input"], DataSpec)
        assert kwargs["input"].input == [1, 2]
        path = expected_dir / "steps" / f"sample-{kwargs['context_data']['call_id']}" / "result.json"
        path.write_text(json.dumps({"status": "done", "data": {"value": None}}))
        return PromptResult.satisfied()

    spec = ComputeOpSpec(name="sample", subkind="agent", exe_data={"agent": "worker", "prompt": "answer", "input": "missing"},
                         input=["int"], output="?int")
    kwargs = {"workdir": override_dir} if explicit_workdir else {}
    answer = await runner.run_op(spec, input=[1, 2], trusted=True, context=context, launch=launch, **kwargs)
    assert answer.exit_code is ExitCode.OK and answer.has_value and answer.value is None
    assert answer.invocation_id == context.invocation_id


def test_prompt_nullable_boundary_rejects_ambiguous_legacy_null():
    spec = ComputeOpSpec(subkind="prompt", exe_data={"prompt": "answer"}, output="?int")
    legacy = PromptResult.model_validate_json('{"exit_code":0,"value":null,"ran":true}')
    missing = runner._with_value(spec, legacy)
    explicit = runner._with_value(spec, PromptResult.satisfied(value=None))
    assert missing.exit_code is ExitCode.NOT_YET and not missing.has_value
    assert explicit.exit_code is ExitCode.OK and explicit.has_value
