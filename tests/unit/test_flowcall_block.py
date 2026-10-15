"""Actual authored Python calls and typed list/answer boundaries, without a server."""

import asyncio
import json
from dataclasses import replace
from typing import ClassVar

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core.compute.declared_value import DeclaredShapeError
from flow_sdk.core.compute_op.context import CallContext
from flow_sdk.core.compute_op.runner import run_op
from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.io.native import Binary, Text
from flow_sdk.schema.data_spec.returned_value_spec import (
    CollectionResult,
    ExitCode,
    ItemAnswer,
    PromptResult,
    ReturnedValue,
)


class Item(DataSpec):
    spec_kind: ClassVar[str] = "test.flowcall.item"
    number: int


class Artifact(DataSpec):
    spec_kind: ClassVar[str] = "test.flowcall.artifact"
    text: Text
    pdf: Binary


class Bundle(DataSpec):
    artifacts: list[Artifact]


def block(tmp_path, source, *, input=None, output=None):
    manifest = tmp_path / "agentic-assets/project_manifest"
    manifest.mkdir(parents=True, exist_ok=True)
    (manifest / "project_manifest.json").write_text(json.dumps({"ns": "test_flowcall"}))
    folder = tmp_path / "agentic-assets/compute_op/sample"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "call.py").write_text(source)
    spec = ComputeOpSpec(name="sample", subkind="python", exe_data={}, input=input, output=output)
    return spec, CallContext(asset_folder=folder)


def test_nested_answers_keep_types_refs_and_unknown_tags():
    ref = f"test.flowcall.item.id.{mint_uuid()}"
    value = [{"known": Item(number=2), "ref": ref, "future": {"spec_kind": "future.kind", "x": 1}}]
    restored = ReturnedValue.model_validate_json(ReturnedValue.satisfied(value=value).model_dump_json())
    assert restored.value == value
    assert isinstance(restored.value[0]["known"], Item)


@pytest.mark.parametrize("value,present", [(None, True), ([], True), (False, True), (0, True)])
def test_explicit_values_survive_presence_roundtrip(value, present):
    answer = ReturnedValue.satisfied(value=value)
    assert ReturnedValue.model_validate_json(answer.model_dump_json()).has_value is present
    assert not ReturnedValue.satisfied().has_value
    assert "value_present" not in ReturnedValue.satisfied().model_dump()


def test_collection_trim_keeps_item_values():
    answer = CollectionResult(items=[ItemAnswer(index=0, answer=PromptResult.satisfied(value=[1], text="abcdef"))])
    assert answer.trimmed(3).items[0].answer.text == "def"
    assert answer.trimmed(3).items[0].answer.value == [1]
    assert isinstance(CollectionResult.model_validate_json(answer.model_dump_json()).items[0].answer, PromptResult)


def test_file_content_survives_nested_folder_io(tmp_path):
    content = b"%PDF-fake\x00\x80\xff"
    original = Bundle(artifacts=[Artifact(text="hello", pdf=Binary.of(content, "application/pdf"))])
    original.save(tmp_path / "payload")
    read = Bundle.load(tmp_path / "payload")
    assert read.artifacts[0].text == "hello"
    assert read.artifacts[0].pdf == content
    assert read.artifacts[0].pdf.path.read_bytes() == content

    answer = ReturnedValue.satisfied(value={"artifacts": read.artifacts})
    answer.save(tmp_path / "answer")
    for restored in (
        ReturnedValue.model_validate_json(answer.model_dump_json()),
        ReturnedValue.load(tmp_path / "answer"),
    ):
        artifact = restored.value["artifacts"][0]
        assert isinstance(artifact, Artifact)
        assert isinstance(artifact.text, Text)
        assert isinstance(artifact.pdf, Binary)
        assert artifact.text == "hello"
        assert artifact.pdf == content
        assert artifact.pdf.media_type == "application/pdf"
        # The envelope transports content; only native payload I/O materializes files.
        assert artifact.pdf.path is None


@pytest.mark.parametrize("shape", [["unknown.call.kind"], {"item": "?unknown.call.kind"}, {"*": "unknown.call.kind"}])
def test_unknown_declared_kind_is_not_any(shape):
    with pytest.raises(ValueError, match="unknown"):
        ComputeOpSpec(subkind="python", exe_data={}, input=shape)


def test_legacy_output_spelling_and_conflict():
    legacy = ComputeOpSpec(subkind="python", exe_data={}, output_spec_kind="int")
    assert legacy.output_shape == "int"
    assert "input" not in legacy.model_dump() and "output" not in legacy.model_dump()
    with pytest.raises(ValueError, match="conflicting"):
        ComputeOpSpec(subkind="python", exe_data={}, output_spec_kind="int", output=["int"])


@pytest.mark.asyncio
async def test_authority_input_output_and_relative_import(tmp_path):
    spec, ctx = block(tmp_path, "from .helper import inc\nfrom flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\ndef call(input, *, context):\n return ReturnedValue.satisfied(value=[inc(x) for x in input])\n", input=["int"], output=["int"])
    (ctx.asset_folder / "helper.py").write_text("def inc(x): return x + 1\n")
    assert (await run_op(spec, input=[1], context=ctx)).exit_code == ExitCode.REFUSED
    with pytest.raises(DeclaredShapeError):
        await run_op(spec, input=["bad"], context=ctx, trusted=True)
    assert (await run_op(spec, input=[1], context=ctx, trusted=True)).value == [2]
    assert (await run_op(spec, input=[], context=ctx, trusted=True)).value == []
    (ctx.asset_folder / "helper.py").write_text("def inc(x): return x + 2\n")
    assert (await run_op(spec, input=[1], context=ctx, trusted=True)).value == [3]


@pytest.mark.asyncio
async def test_unapproved_and_invalid_input_never_import(tmp_path):
    marker = tmp_path / "imported"
    spec, ctx = block(tmp_path, f"from pathlib import Path\nPath({str(marker)!r}).touch()\ndef call(input, *, context): pass\n", input="int")
    await run_op(spec, input=1, context=ctx)
    with pytest.raises(DeclaredShapeError):
        await run_op(spec, input="bad", context=ctx, trusted=True)
    assert not marker.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("expression,expected", [("value=None", ExitCode.OK), ("", ExitCode.NOT_YET), ("value='bad'", ExitCode.NOT_YET)])
async def test_nullable_output_is_distinct_from_missing(tmp_path, expression, expected):
    spec, ctx = block(tmp_path, f"from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\nasync def call(input, *, context):\n assert input is None\n return ReturnedValue.satisfied({expression})\n", output="?int")
    result = await run_op(spec, context=ctx, trusted=True)
    assert result.exit_code == expected
    assert result.value_present is (expected == ExitCode.OK)


@pytest.mark.asyncio
async def test_bare_return_is_contract_error(tmp_path):
    spec, ctx = block(tmp_path, "def call(input, *, context): return []\n")
    with pytest.raises(TypeError, match="ReturnedValue"):
        await run_op(spec, context=ctx, trusted=True)


@pytest.mark.asyncio
async def test_named_list_wire_value_can_feed_the_next_call(tmp_path):
    spec, ctx = block(tmp_path, "from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\ndef call(input, *, context): return ReturnedValue.satisfied(value=sum(item.number for item in input))\n", input=[Item.spec_kind], output="int")
    wire = ReturnedValue.satisfied(value=[Item(number=2), Item(number=3)]).model_dump(mode="json")["value"]
    assert (await run_op(spec, input=wire, context=ctx, trusted=True)).value == 5
    with pytest.raises(DeclaredShapeError):
        await run_op(spec, input=[{"spec_kind": "unknown.kind", "number": 2}], context=ctx, trusted=True)


@pytest.mark.asyncio
async def test_same_named_asset_roots_have_distinct_modules(tmp_path):
    source = "from pathlib import Path\nfrom flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\ndef call(input, *, context): return ReturnedValue.satisfied(value=str(Path(__file__).parent))\n"
    spec, a = block(tmp_path / "a", source, output="string")
    _, b = block(tmp_path / "b", source, output="string")
    assert (await run_op(spec, context=a, trusted=True)).value == str(a.asset_folder)
    assert (await run_op(spec, context=b, trusted=True)).value == str(b.asset_folder)


@pytest.mark.asyncio
async def test_reused_context_has_distinct_calls_but_shared_correlation(tmp_path):
    spec, ctx = block(tmp_path, "from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\nasync def call(input, *, context): return ReturnedValue.satisfied(value=context.call_id)\n", output="string")
    a, b = await asyncio.gather(*(run_op(spec, context=ctx, trusted=True) for _ in range(2)))
    assert a.value != b.value
    assert a.invocation_id == b.invocation_id == ctx.invocation_id


@pytest.mark.asyncio
async def test_missing_namespace_refuses_before_import(tmp_path):
    spec, ctx = block(tmp_path, "raise AssertionError('must not import')\n")
    (tmp_path / "agentic-assets/project_manifest/project_manifest.json").unlink()
    with pytest.raises(ValueError, match="namespace"):
        await run_op(spec, context=ctx, trusted=True)


@pytest.mark.asyncio
async def test_explicit_reference_resolution(tmp_path):
    from flow_sdk.values import save_value, store_of

    ctx = CallContext(asset_folder=tmp_path)
    item = Item(number=7)
    ref = save_value(item, store_of(tmp_path))
    assert await ctx.resolve([ref, "ordinary", item]) == [item, "ordinary", item]
    assert await CallContext(asset_folder=tmp_path / "other").resolve(ref, near=store_of(tmp_path)) == item
    with pytest.raises(DeclaredShapeError, match="Cannot resolve"):
        await ctx.resolve(f"test.flowcall.item.id.{mint_uuid()}")


@pytest.mark.asyncio
async def test_legacy_entity_save_does_not_add_shape_nulls(tmp_path):
    from flow_sdk.builtin.compute_op import ComputeOp
    from flow_sdk.schema.data_spec.compute_op_spec import CliOp

    folder = tmp_path / "legacy"
    op = ComputeOp(name="legacy", asset_ref=str(folder), exe_data=CliOp(commands={"linux": "echo 1"}),
                   output_spec_kind="int")
    await op.save()
    original = json.loads((folder / "compute_op.json").read_text())
    assert "input" not in original and "output" not in original
    op.description = "changed"
    await op.save()
    saved = json.loads((folder / "compute_op.json").read_text())
    assert saved["output_spec_kind"] == "int"
    assert "input" not in saved and "output" not in saved


@pytest.mark.asyncio
async def test_async_cancellation_propagates(tmp_path):
    spec, ctx = block(tmp_path, "import asyncio\nasync def call(input, *, context):\n context.parent.set()\n await asyncio.Event().wait()\n")
    started = asyncio.Event()
    task = asyncio.create_task(run_op(spec, context=replace(ctx, parent=started), trusted=True))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
@pytest.mark.parametrize("finish_statement", ["return ReturnedValue.satisfied()", "raise ValueError('late failure')"])
async def test_sync_cancellation_settles_thread_before_return(tmp_path, finish_statement):
    import threading

    spec, ctx = block(tmp_path, "from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\ndef call(input, *, context):\n started, finish = context.parent\n started.set()\n finish.wait()\n " + finish_statement + "\n")
    started, finish = threading.Event(), threading.Event()
    task = asyncio.create_task(run_op(spec, context=replace(ctx, parent=(started, finish)), trusted=True))
    await asyncio.to_thread(started.wait)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    finish.set()
    with pytest.raises(asyncio.CancelledError):
        await task
