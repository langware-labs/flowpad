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
