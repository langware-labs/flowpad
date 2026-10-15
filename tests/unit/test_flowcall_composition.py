"""Local commands compose typed FlowCall values without a model or browser."""
import json
import shlex
import sys
from typing import ClassVar

import pytest

from flow_sdk.core.wizard.runner import Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import WizardResult
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)


class FlowCallPort(DataSpec):
    spec_kind: ClassVar[str] = 'test.flowcall.port'
    port: int


@pytest.mark.asyncio
@pytest.mark.parametrize('valid', [True, False])
async def test_typed_value_composes_and_survives_disk_round_trip(tmp_path, valid):
    producer = tmp_path / 'produce.py'
    producer.write_text('print(' + repr(json.dumps({'port': 8080 if valid else 'invalid'})) + ')\n')
    consumer = tmp_path / 'consume.py'
    consumer.write_text("import json, os\nfrom pathlib import Path\nv=json.loads(os.environ['FLOWPAD_WIZARD_INPUT_PORT'])\nPath('consumed').write_text(str(v['port']))\n")
    ops = {}
    for name, script in [('produce', producer), ('consume', consumer)]:
        ops[name] = ComputeOpSpec(name=name, subkind='cli',
            output_spec_kind=FlowCallPort.spec_kind if name == 'produce' else None,
            exe_data={'commands': {sys.platform: f'{shlex.quote(sys.executable)} {shlex.quote(str(script))}'}})

    async def resolve(name):
        return Resolved(ops[name], trusted=True)

    wizard = WizardSpec(name='compose', steps=[
        {'id': 'produce', 'ref': 'produce', 'bind': 'PORT'},
        {'id': 'consume', 'ref': 'consume', 'args': {'PORT': 'PORT'}},
    ])
    answer = await run_wizard(wizard, trusted=True, workdir=tmp_path, resolve_op=resolve)
    saved = tmp_path / 'run.json'
    saved.write_text(answer.model_dump_json())
    restored = WizardResult.model_validate_json(saved.read_text())
    assert restored.model_dump() == answer.model_dump()
    if valid:
        assert restored.ok
        assert isinstance(restored.steps['produce'].value, FlowCallPort)
        assert restored.steps['produce'].value.port == 8080
        assert (tmp_path / 'consumed').read_text() == '8080'
    else:
        assert not restored.ok
        assert restored.steps['produce'].value is None
        assert 'consume' not in restored.steps
        assert not (tmp_path / 'consumed').exists()


def python_blocks(tmp_path, definitions):
    """Real local entrypoints; the resolver is the same seam used by indexed Wizards."""
    found = {}
    for name, input_shape, output_shape, body in definitions:
        folder = tmp_path / name
        folder.mkdir()
        (folder / 'call.py').write_text(
            'from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue\n'
            'async def call(input, *, context):\n' + ''.join(f'    {line}\n' for line in body.splitlines())
        )
        found[name] = Resolved(ComputeOpSpec(name=name, subkind='python', input=input_shape,
                                            output=output_shape, exe_data={}), True, folder)

    async def resolve(name):
        return found.get(name)

    return resolve


@pytest.mark.asyncio
async def test_python_list_chain_and_map_keep_values_and_steps(tmp_path):
    from flow_sdk.core.compute_op.composition import chain, map_calls

    resolve = python_blocks(tmp_path, [
        ('dedupe', ['int'], ['int'], 'return ReturnedValue.satisfied(value=list(dict.fromkeys(input)))'),
        ('route', ['int'], ['int'], 'return ReturnedValue.satisfied(value=input if input else [])'),
        ('double', 'int', 'int', 'return ReturnedValue.satisfied(value=input * 2)'),
    ])
    answer = await chain('dedupe', 'route').call(input=[2, 1, 2], resolve_op=resolve, workdir=tmp_path)
    assert answer.value == [2, 1] and answer.has_value
    assert list(answer.steps) == ['step_0', 'step_1']
    mapped = await map_calls('double', answer.value, resolve_op=resolve, workdir=tmp_path)
    assert mapped.value == [4, 2] and [r.index for r in mapped.items] == [0, 1]
    empty = await chain('dedupe', 'route').call(input=[], resolve_op=resolve, workdir=tmp_path)
    assert empty.value == [] and empty.has_value


@pytest.mark.asyncio
@pytest.mark.parametrize('producer,expected', [
    ('return ReturnedValue.satisfied(value=None)', True),
    ('return ReturnedValue.satisfied()', False),
    ('return ReturnedValue.not_applicable("skip")', False),
])
async def test_nullable_value_is_distinct_from_missing_or_skip(tmp_path, producer, expected):
    from flow_sdk.core.compute_op.composition import chain

    resolve = python_blocks(tmp_path, [
        ('produce', None, '?int', producer),
        ('consume', '?int', 'bool', 'return ReturnedValue.satisfied(value=input is None)'),
    ])
    answer = await chain('produce', 'consume').call(resolve_op=resolve, workdir=tmp_path)
    saved = WizardResult.model_validate_json(answer.model_dump_json())
    assert saved.ok is expected
    if not expected:
        assert 'step_1' not in saved.steps or not saved.steps['step_1'].ran
    if expected:
        assert saved.value is True and saved.steps['step_0'].has_value


@pytest.mark.asyncio
async def test_collect_keeps_item_identity_and_never_compacts_partial_values(tmp_path):
    from flow_sdk.core.compute_op.composition import map_calls
    from flow_sdk.schema.data_spec.returned_value_spec import CollectionResult, ExitCode

    resolve = python_blocks(tmp_path, [
        ('positive', 'int', 'int',
         'return ReturnedValue.satisfied(value=input) if input > 0 else ReturnedValue.not_yet("negative")'),
    ])
    result = await map_calls('positive', [1, -1, 2], on_error='collect', key=str,
                             resolve_op=resolve, workdir=tmp_path)
    restored = CollectionResult.model_validate_json(result.model_dump_json())
    assert restored.exit_code is ExitCode.NOT_YET and not restored.has_value
    assert [(r.index, r.key, r.answer.ok) for r in restored.items] == [(0, '1', True), (1, '-1', False), (2, '2', True)]
    stopped = await map_calls('positive', [1, -1, 2], resolve_op=resolve, workdir=tmp_path)
    assert len(stopped.items) == 2


@pytest.mark.asyncio
async def test_map_program_error_propagates_and_inline_record_shapes_chain(tmp_path):
    from flow_sdk.core.compute_op.composition import chain, map_calls

    resolve = python_blocks(tmp_path, [
        ('record', {'number': 'int'}, {'number': 'int'}, 'return ReturnedValue.satisfied(value=input)'),
        ('broken', 'int', 'int', 'raise RuntimeError("program bug")'),
    ])
    result = await chain('record', 'record').call(input={'number': 2}, resolve_op=resolve, workdir=tmp_path)
    assert result.value.number == 2
    with pytest.raises(RuntimeError, match='program bug'):
        await map_calls('broken', [1, 2], on_error='collect', resolve_op=resolve, workdir=tmp_path)


def test_typed_step_literal_presence_survives_round_trip():
    from flow_sdk.schema.data_spec.wizard_spec import WizardStepSpec

    step = WizardStepSpec(id='null', ref='target', input_value=None)
    assert 'input_value' in WizardStepSpec.model_validate_json(step.model_dump_json()).model_fields_set
    plain = WizardStepSpec(id='plain', ref='target')
    assert 'input_value' not in plain.model_dump()
    with pytest.raises(ValueError, match='not both'):
        WizardStepSpec(id='bad', ref='target', input_value=None, input_from='$input')


@pytest.mark.asyncio
async def test_chain_validates_next_boundary_before_consumer_effect(tmp_path):
    from flow_sdk.core.compute_op.composition import chain

    resolve = python_blocks(tmp_path, [
        ('integer', None, 'int', 'return ReturnedValue.satisfied(value=2)'),
        ('nullable', '?int', 'int', 'return ReturnedValue.satisfied(value=input)'),
        ('record_only', {'number': 'int'}, 'int',
         'context.workdir.joinpath("consumer-ran").touch()\nreturn ReturnedValue.satisfied(value=1)'),
    ])
    assert (await chain('integer', 'nullable').call(resolve_op=resolve, workdir=tmp_path)).value == 2
    from flow_sdk.core.compute.declared_value import DeclaredShapeError
    with pytest.raises(DeclaredShapeError):
        await chain('integer', 'record_only').call(resolve_op=resolve, workdir=tmp_path)
    assert not (tmp_path / 'consumer-ran').exists()


@pytest.mark.asyncio
async def test_map_activity_preserves_reached_outcomes_after_exception(tmp_path):
    from flow_sdk.activity import Activity
    from flow_sdk.core.compute_op.composition import map_calls
    from flow_sdk.core.compute_op.context import CallContext

    resolve = python_blocks(tmp_path, [
        ('sometimes', 'int', 'int',
         'if input < 0: raise RuntimeError("broken item")\nreturn ReturnedValue.satisfied(value=input)'),
    ])
    parent = Activity.get('flowcall-test-map')
    context = CallContext(asset_folder=tmp_path, parent=parent)
    with pytest.raises(RuntimeError, match='broken item'):
        await map_calls('sometimes', [1, -1, 3], context=context, on_error='collect', resolve_op=resolve)
    root = next(iter(parent._children.values()))
    assert list(root._children) == ['0', '1']
    assert root._children['0'].is_terminal and root._children['1'].is_terminal
    assert root._children['0'].state != root._children['1'].state


@pytest.mark.asyncio
async def test_nested_typed_wizard_keeps_invocation_and_python_needs_code_folder(tmp_path):
    from flow_sdk.core.compute_op.composition import chain, map_calls

    resolve = python_blocks(tmp_path, [('identity', 'int', 'int', 'return ReturnedValue.satisfied(value=input)')])
    inner = WizardSpec(name='inner', output='int', output_from='leaf',
                       steps=[{'id': 'leaf', 'ref': 'identity', 'input_from': '$input'}])
    outer = WizardSpec(name='outer', output='int', output_from='nested',
                       steps=[{'id': 'nested', 'kind': 'wizard', 'ref': 'inner', 'input_from': '$input'}])

    async def resolve_wizard(name):
        return Resolved(inner, True)

    answer = await run_wizard(outer, trusted=True, input=2, resolve_op=resolve,
                              resolve_wizard=resolve_wizard, workdir=tmp_path)
    nested = answer.steps['nested']
    assert answer.value == 2
    assert answer.invocation_id == nested.invocation_id == nested.steps['leaf'].invocation_id
    spec = ComputeOpSpec(name='no-code-folder', subkind='python', input='int', output='int', exe_data={})
    (tmp_path / 'call.py').write_text('raise RuntimeError("must never import cwd")')
    with pytest.raises(ValueError, match='explicit asset folder'):
        await chain(spec).call(input=1, approved=True, workdir=tmp_path)
    with pytest.raises(ValueError, match='explicit asset folder'):
        await map_calls(spec, [1], approved=True, workdir=tmp_path)


@pytest.mark.asyncio
@pytest.mark.parametrize('override', [False, True])
async def test_mixed_cli_python_chain_shares_effective_workdir(tmp_path, override):
    from flow_sdk.core.compute_op.composition import chain, map_calls
    from flow_sdk.core.compute_op.context import CallContext

    inherited = tmp_path / 'inherited'
    explicit = tmp_path / 'explicit'
    inherited.mkdir()
    explicit.mkdir()
    resolve_python = python_blocks(tmp_path, [
        ('verify-cwd', 'string', 'bool', 'return ReturnedValue.satisfied(value=input == str(context.workdir))'),
        ('where', 'int', 'string', 'return ReturnedValue.satisfied(value=str(context.workdir))'),
    ])
    script = tmp_path / 'cwd.py'
    script.write_text('import json, os\nprint(json.dumps(os.getcwd()))\n')
    producer = ComputeOpSpec(name='cli-cwd', subkind='cli', output='string',
        exe_data={'commands': {sys.platform: f'{shlex.quote(sys.executable)} {shlex.quote(str(script))}'}})

    async def resolve(name):
        return Resolved(producer, True) if name == 'cli-cwd' else await resolve_python(name)

    context = CallContext(asset_folder=tmp_path, workdir=inherited)
    kwargs = {'workdir': explicit} if override else {}
    answer = await chain('cli-cwd', 'verify-cwd').call(context=context, resolve_op=resolve, **kwargs)
    assert answer.ok and answer.value is True
    assert answer.steps['step_0'].value == str(explicit if override else inherited)
    mapped = await map_calls('where', [1], context=context, resolve_op=resolve, **kwargs)
    assert mapped.value == [str(explicit if override else inherited)]
