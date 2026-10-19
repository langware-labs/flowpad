"""`Project.hidden` — the ONE published answer to "is this a project you work in".

A hidden project is app-managed infrastructure the user VISITS: the SDK-shipped
Flowpad Assistant, a help-desk portal checkout, the agent mount root. The
frontend needs the answer for more than list filtering — such a project must
never become the CURRENT project, or opening the help desk silently switches the
footer, the workdir and every project-scoped action out of the project the user
was actually in.

It is computed, not stored, and that is the whole point: `helpdesk-ensure`
deliberately does not stamp `system` on the portal (that flag means
"SDK-shipped", which the portal is not), and rows minted by the per-cwd project
walk carry no flag at all. Both are recognised by WHERE THEY LIVE — which no
client can check, which is why the server publishes the verdict instead of
letting each client re-derive it.
"""

import flow_sdk.config as config
from flow_sdk.builtin.project import Project
from flow_sdk.server.routes.bootstrap import project_to_dict


def _project(**fields) -> Project:
    return Project(id="55555555-5555-4555-8555-555555555555", name="p", **fields)


def test_an_ordinary_project_is_not_hidden(tmp_path):
    assert _project(fs_storage_mount_path=str(tmp_path / "work")).hidden is False


def test_a_helpdesk_portal_checkout_is_hidden_without_carrying_the_system_flag(monkeypatch, tmp_path):
    """The case the `system` flag alone misses — and the one that moved the footer."""
    monkeypatch.setattr(config, "agent_workspace_root", lambda: tmp_path)
    portal = config.helpdesk_project_dir("hub-project-id")
    portal.mkdir(parents=True)

    project = _project(fs_storage_mount_path=str(portal), uname=config.HELPDESK_PORTAL_UNAME)

    assert project.system is False
    assert project.hidden is True


def test_an_sdk_shipped_project_is_hidden_by_its_flag():
    assert _project(system=True).hidden is True


def test_the_opening_project_carries_the_verdict():
    """A sandbox adopts `default_project` before any route runs, so the compact
    boot payload has to say so — nothing else can supply it at that moment."""
    payload = project_to_dict(_project(system=True))

    assert payload["hidden"] is True
    assert project_to_dict(_project())["hidden"] is False
