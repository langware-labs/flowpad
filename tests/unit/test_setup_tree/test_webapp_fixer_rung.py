"""A web app's setup step ends in the setup-fixer: repair, then the step again — its check is the proof."""
from types import SimpleNamespace

from flow_sdk.core.setup.derive import FIXER_AGENT, _fixer_prompt, _op


def test_a_step_with_a_fixer_repairs_then_runs_itself_again():
    op = _op("app:start", "Start shop", "start", fixer="repair it")
    agent, again = op.attempts
    assert (agent.subkind, agent.exe_data.agent, agent.exe_data.prompt) == ("agent", FIXER_AGENT, "repair it")
    assert (again.subkind, again.exe_data.webapp_step) == ("cli", "start")
    assert op.completion_check.webapp_step == "start", "the step's own check is the proof"


def test_a_step_without_one_has_no_last_resort():
    assert _op("app:present", "Verify display", "present").attempts == []


def test_the_fixer_is_told_which_app_and_where():
    app = SimpleNamespace(name="shop", typeid="micro_app-1", asset_ref="/p/shop")
    said = _fixer_prompt("p1", app)
    assert all(part in said for part in ("setup-fixer", "micro_app-1", "/p/shop", "p1"))


async def test_a_load_keeps_the_fixer_only_of_a_step_marked_fix_on_load():
    from types import SimpleNamespace

    from flow_sdk.core.setup.load import LoadTree

    ops = {"app:up": _op("app:up", "Start shop", "up", fixer="repair it", fix_on_load=True),
           "other:start": _op("other:start", "Start other", "start", fixer="repair it")}

    from flow_sdk.core.wizard.runner import Resolved

    async def resolve_op(name):
        return Resolved(spec=ops[name])

    load = LoadTree(SimpleNamespace(root="r", resolve_op=resolve_op, resolve_node=None))
    assert [r.subkind for r in (await load.resolve_op("app:up")).spec.attempts] == ["agent", "cli"]
    assert (await load.resolve_op("other:start")).spec.attempts == []
