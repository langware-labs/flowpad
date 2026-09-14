"""The four interactive wizards are WIZARD ASSETS, not bare agent names.

Before this, `launchWizard('git-context-folder', …)` worked because the wizard
name happened to be a SubAgent name — an assumption with no declaration behind
it. A wizard had no description, no icon, and nothing to open in the UI. Now a
document declares the agent that drives it, and the launcher reads the document.

These pin the contract the launcher depends on: the wizard exists under the name
its call sites use, and it names a system sub-agent that is actually installed.
A rename on either side breaks here rather than at a user's click.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.wizard import Wizard
from flow_sdk.config import system_projects_root
from flow_sdk.fs_store.indexer.functions.wizard import read_wizard
from flow_sdk.builtin.subagent_loading import load_system_subagent
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

WIZARD_ROOT = system_projects_root() / "flowpad_assistant" / "agentic-assets" / "wizard"

#: The name each call site passes to `launchWizard`, and the folder holding it.
#: The two differ for asset-cleanup — the folder is the asset, the `name` in the
#: document is the contract — which is why this is a mapping and not a glob.
LAUNCHED = {
    "git-context-folder": "git-context-folder",
    "task-analyze": "task-analyze",
    "asset-cleanup-wizard": "asset-cleanup",
    "webapp-fixer": "webapp-fixer",
}


@pytest.mark.parametrize("launch_name,folder", sorted(LAUNCHED.items()))
def test_a_launched_wizard_declares_a_driver_that_ships(launch_name: str, folder: str):
    """Everything the launcher needs, in one place.

    `load_system_subagent` is the loader the runtime itself resolves through —
    not a second frontmatter scan written here, which would be free to disagree
    with it about what an agent name means.
    """
    spec = read_wizard(WIZARD_ROOT / folder)
    assert spec is not None, f"{folder}/wizard.json does not parse — the launcher finds nothing"
    assert spec.name == launch_name, (
        f"call sites launch {launch_name!r}; the document calls itself {spec.name!r}. "
        "The launcher matches on the document's name, so these must agree."
    )
    assert spec.enabled

    wizard = Wizard(name=launch_name, asset_ref=str(WIZARD_ROOT / folder))
    assert wizard.agent, f"{folder} declares no agent, so nothing can drive the conversation"
    assert load_system_subagent(wizard.agent) is not None, (
        f"{folder} names sub-agent {wizard.agent!r}, which is not installed"
    )
    # No steps: the conversation IS the run. A fabricated step would put a Run
    # button on this in the viewer that spawns the agent with no payload.
    assert not spec.steps


def test_a_document_cannot_be_both_a_conversation_and_a_sequence():
    """The discriminator that makes `agent` safe to read.

    Without it, a conversational document that grew a second step would still
    resolve — the launcher embeds one agent and would silently never reach the
    rest.
    """
    with pytest.raises(Exception, match="both an agent and steps"):
        WizardSpec.model_validate({
            "name": "both",
            "agent": "someone",
            "steps": [{"id": "s", "command": {"commands": {"linux": "true"}}}],
        })
    with pytest.raises(Exception, match="neither an agent nor any steps"):
        WizardSpec.model_validate({"name": "empty"})


def test_every_shipped_wizard_is_reachable():
    """A wizard is launched from the UI (it declares an agent) or run by the
    backend (it carries a trigger child asset). One that is neither is a wizard nobody can
    reach — which is the property worth guarding, rather than a hand-kept list
    of names that fails whenever a correct wizard is added."""
    unreachable = []
    for folder in sorted(p for p in WIZARD_ROOT.iterdir() if p.is_dir()):
        spec = read_wizard(folder)
        assert spec is not None, f"{folder.name}/wizard.json does not parse"
        has_trigger_child = (folder / "agentic-assets" / "trigger").is_dir()
        if not spec.agent and not has_trigger_child:
            unreachable.append(folder.name)
    assert not unreachable, (
        f"these wizards can be neither launched nor triggered: {unreachable}. "
        "Declare an `agent` (launched from a surface) or a trigger child asset "
        "(run by the backend)."
    )
