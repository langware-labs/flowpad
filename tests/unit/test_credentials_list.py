"""``flow credentials list``, the session prompt's "Credentials:" block, and secrets as a deploy advisory.

Pure functions over a ``credentials_status`` answer: names and variables come out, a value never does.
"""
from types import SimpleNamespace

from flow_sdk.builtin.agent_cloud_deploy import credential_warnings, funding_warnings
from flow_sdk.builtin.credential_listing import PROMPT_NOTE, listing, listing_text, prompt_block
from flow_sdk.builtin.project_setup import _undeclared_for_agents
from flow_sdk.schema.data_spec.permission_spec import STATUS_MISSING
from flow_sdk.schema.data_spec.project_setup_spec import RootRef
from flow_sdk.schema.data_spec.requirement_spec import (
    REQUIREMENT_CREDENTIAL,
    REQUIREMENT_FUNDING,
    REQUIREMENT_PERMISSION,
    REQUIREMENT_VARIABLE,
    ReadinessItemSpec,
    ReadinessSpec,
    RequirementSpec,
)

SECRET = "xh_live_very_secret_value"


def _status() -> dict:
    # A value never rides a status answer; one planted anyway must not leak through the listing.
    return {
        "credentials": [
            {"name": "xhostd", "scope": "user", "state": "missing", "vars": [{"env_var": "XHOSTD_TOKEN"}]},
            {"name": "xhostd", "scope": "project", "state": "connected",
             "vars": [{"env_var": "XHOSTD_TOKEN", "present": True, "value": SECRET}]},
            {"name": "openai", "scope": "user", "state": "missing", "vars": [{"env_var": "OPENAI_API_KEY"}]},
        ]
    }


def test_listing_names_vars_and_availability_project_row_wins():
    assert listing(_status()) == [
        {"name": "openai", "vars": ["OPENAI_API_KEY"], "available": False},
        {"name": "xhostd", "vars": ["XHOSTD_TOKEN"], "available": True},
    ]


def test_listing_by_scope_keeps_only_the_projects_own():
    assert [r["name"] for r in listing(_status(), scope="project")] == ["xhostd"]


def test_listing_text_is_one_aligned_line_per_credential():
    text = listing_text(listing(_status()))
    assert text.splitlines() == [
        "openai   OPENAI_API_KEY   missing",
        "xhostd   XHOSTD_TOKEN     available",
    ]
    assert SECRET not in text


def test_prompt_block_names_only_with_the_env_line():
    block = prompt_block(listing(_status(), scope="project"))
    assert block == f"Credentials:\nxhostd   XHOSTD_TOKEN   available\n{PROMPT_NOTE}\n"
    assert SECRET not in block
    assert PROMPT_NOTE == "These are loaded into this machine's environment; read them by variable name."


def test_prompt_block_skipped_when_the_project_has_none():
    assert prompt_block(listing({"credentials": []})) is None
    assert prompt_block(listing(_status(), scope="nobody")) is None


def _missing(kind: str, name: str) -> ReadinessItemSpec:
    return ReadinessItemSpec(requirement=RequirementSpec(kind=kind, name=name), status=STATUS_MISSING,
                             vars=[name.upper()], missing=[name.upper()], fix="set it")


def test_a_missing_credential_or_variable_warns_and_never_blocks():
    items = [_missing(REQUIREMENT_CREDENTIAL, "xhostd"), _missing(REQUIREMENT_VARIABLE, "EXTRA_VAR")]
    ready = ReadinessSpec(agent_id="a", deployment_id="d", environment="development",
                          ready=not any(i.blocks for i in items), items=items)
    assert ready.ready
    assert [i.requirement.name for i in ready.advisories()] == ["xhostd", "EXTRA_VAR"]
    assert credential_warnings(ready) == [
        "Secret xhostd missing: set it on the agent's Env tab; machines get it then",
        "Secret EXTRA_VAR missing: set it on the agent's Env tab; machines get it then",
    ]
    assert funding_warnings(SimpleNamespace(name="Game Builder", id="a"), ready) == []


def test_a_missing_permission_still_blocks():
    assert _missing(REQUIREMENT_PERMISSION, "permission.mail.send").blocks
    assert not _missing(REQUIREMENT_FUNDING, "llm").blocks


def _agent_root() -> RootRef:
    return RootRef(typeid="agent-1", kind="agent", name="Game Builder")


def test_an_agent_credential_only_the_user_declares_is_a_project_issue():
    rows = {"xhostd": SimpleNamespace(scope="user")}
    gap = _undeclared_for_agents("xhostd", [_agent_root()], rows)
    assert gap is not None and gap.name == "xhostd" and gap.used_by == ["Game Builder"]
    assert "this project does not declare it" in gap.note


def test_a_declared_or_unknown_credential_is_no_extra_issue():
    assert _undeclared_for_agents("xhostd", [_agent_root()], {"xhostd": SimpleNamespace(scope="project")}) is None
    assert _undeclared_for_agents("xhostd", [_agent_root()], {}) is None  # the caller's own gap says it
    source = RootRef(typeid="data_source-1", kind="data_source", name="feed")
    assert _undeclared_for_agents("xhostd", [source], {"xhostd": SimpleNamespace(scope="user")}) is None
