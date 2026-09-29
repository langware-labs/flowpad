"""A shipped wizard or op looked up by name is THIS install's copy, even when a project shadows it.

A developer with the Flowpad repo open as a project has a second copy of every shipped asset
indexed — ``<checkout>/flow_sdk/system_projects/...`` — and ``get_one`` refused the name with two
matches: "Run setup again" answered 500 ("Multiple (2) existing entities ... llm-setup"), and a
wizard step naming its op would have failed the same way. The shadow is laid out here exactly as
a checkout is, so it looks shipped by shape (``is_system_project_path``) and only the running
install's location tells the two apart.
"""

from __future__ import annotations

import json
import shutil
import uuid

import pytest

from flow_sdk.builtin.compute_op import ComputeOp
from flow_sdk.builtin.wizard import Wizard
from flow_sdk.config import is_running_install_path, system_projects_root
from tests.fixtures.identity import index_path
from tests.pytest_plugin import async_context

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SHIPPED = system_projects_root() / "flowpad_assistant" / "agentic-assets"


def _checkout_copy(tmp_path, family: str, name: str):
    """A copy of a shipped asset where a repo checkout keeps it."""
    target = (
        tmp_path / "checkout" / "flow_sdk" / "system_projects" / "flowpad_assistant" / "agentic-assets" / family / name
    )
    # Without its identity capsule: a real checkout's copy is a different entity (its own id),
    # and a copied capsule would make the shadow overwrite the shipped row instead of sitting beside it.
    shutil.copytree(SHIPPED / family / name, target, ignore=shutil.ignore_patterns(".flow"))
    return target


async def _cleanup(*rows):
    for row in rows:
        if row is not None:
            await row.delete()


@async_context
async def test_the_setup_wizard_resolves_to_this_install_when_a_checkout_shadows_it(tmp_path):
    shipped = await Wizard.get_by_id((await index_path("wizard", SHIPPED / "wizard" / "llm-setup", write=False)).id)
    shadow = await Wizard.get_by_id((await index_path("wizard", _checkout_copy(tmp_path, "wizard", "llm-setup"))).id)
    try:
        assert len(await Wizard.get_all({"name": "llm-setup"})) == 2, "the shadow is indexed beside the real one"

        found = await Wizard.by_name("llm-setup")

        assert found is not None and str(found.id) == str(shipped.id)
        assert is_running_install_path(found.asset_ref) and not is_running_install_path(shadow.asset_ref)
    finally:
        await _cleanup(shadow, shipped)


@async_context
async def test_a_wizard_steps_op_resolves_the_same_way(tmp_path):
    shipped = await ComputeOp.get_by_id(
        (await index_path("compute_op", SHIPPED / "compute_op" / "git-on-path", write=False)).id
    )
    # An op carries its id INSIDE compute_op.json, so a byte-for-byte copy is the SAME row (the
    # last one indexed wins it). A project op that shares only the NAME is its own entity.
    copy = _checkout_copy(tmp_path, "compute_op", "git-on-path")
    document = json.loads((copy / "compute_op.json").read_text(encoding="utf-8"))
    document["id"] = str(uuid.uuid4())
    (copy / "compute_op.json").write_text(json.dumps(document), encoding="utf-8")
    shadow = await ComputeOp.get_by_id((await index_path("compute_op", copy)).id)
    try:
        assert len(await ComputeOp.get_all({"name": "git-on-path"})) == 2, "the shadow is indexed beside the real one"

        found = await ComputeOp.by_name("git-on-path")

        assert found is not None and str(found.id) == str(shipped.id)
    finally:
        await _cleanup(shadow, shipped)


@async_context
async def test_two_project_wizards_with_one_name_are_still_ambiguous(tmp_path):
    """Neither is this install's, so neither is more right — the caller hears it, as before."""
    rows = []
    for project in ("a", "b"):
        root = tmp_path / project / "agentic-assets" / "wizard" / "same-name"
        root.mkdir(parents=True)
        (root / "wizard.json").write_text(json.dumps({"name": "same-name", "steps": []}), encoding="utf-8")
        rows.append(await Wizard.get_by_id((await index_path("wizard", root)).id))
    try:
        with pytest.raises(ValueError, match="none is this install's"):
            await Wizard.by_name("same-name")
    finally:
        await _cleanup(*rows)


@async_context
async def test_a_single_match_is_simply_returned(tmp_path):
    root = tmp_path / "p" / "agentic-assets" / "wizard" / "only-one"
    root.mkdir(parents=True)
    (root / "wizard.json").write_text(json.dumps({"name": "only-one", "steps": []}), encoding="utf-8")
    row = await Wizard.get_by_id((await index_path("wizard", root)).id)
    try:
        assert str((await Wizard.by_name("only-one")).id) == str(row.id)
        assert await Wizard.by_name("no-such-wizard") is None
    finally:
        await _cleanup(row)
