"""CLI input uses JSON values without conflating omission and null."""
import json
import subprocess
import sys

import pytest
import typer

from flow_sdk.cli.commands.op_cmd import _call_body, _exit_with
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode


def test_input_forms_preserve_values_and_omission(tmp_path):
    assert _call_body(False, None, None) == {"approved": False}
    assert _call_body(True, "null", None) == {"approved": True, "input": None}
    path = tmp_path / "input.json"
    path.write_text('[{"n": 0}, {"n": 2}]')
    assert _call_body(True, None, path)["input"] == [{"n": 0}, {"n": 2}]
    for raw, file in [("[]", path), ("{broken", None)]:
        with pytest.raises(typer.Exit) as error:
            _call_body(False, raw, file)
        assert error.value.exit_code == 2


def test_stdin_is_read_as_json_in_a_real_process():
    program = (
        "import json; from pathlib import Path; "
        "from flow_sdk.cli.commands.op_cmd import _call_body; "
        "print(json.dumps(_call_body(True, None, Path('-'))))"
    )
    result = subprocess.run([sys.executable, "-c", program], input="[]", text=True, capture_output=True, check=True)
    assert json.loads(result.stdout) == {"approved": True, "input": []}


@pytest.mark.parametrize('code', list(ExitCode))
def test_typed_answer_keeps_the_cli_exit_contract(code):
    with pytest.raises(typer.Exit) as error:
        _exit_with({'exit_code': int(code), 'value': [], 'value_present': True})
    assert error.value.exit_code == int(code)
