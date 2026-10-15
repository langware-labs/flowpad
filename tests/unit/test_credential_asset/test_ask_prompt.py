"""The setup question: the value's label first, its own help link only, and why the credential is needed."""
from __future__ import annotations

import json

from flow_sdk.builtin.project_setup import _ask_prompt, compile_setup
from flow_sdk.schema.data_spec.project_setup_spec import REQUIREMENT_PACK, SetupRequirementSpec, SetupVarSpec
from tests.unit.test_credential_asset._shipped import shipped_credential_folders

APP_PASSWORDS = "https://myaccount.google.com/apppasswords"


def _req(*vars: SetupVarSpec) -> SetupRequirementSpec:
    return SetupRequirementSpec(kind=REQUIREMENT_PACK, name="gmail", title="Gmail", help_url=APP_PASSWORDS,
                                needed_for="Reads your Gmail mail into conversations.", vars=list(vars))


def test_a_label_that_names_its_credential_stands_alone_and_no_credential_help_glued_on():
    var = SetupVarSpec(env_var="GMAIL_ADDRESS", label="Gmail address", secret=False)
    assert _ask_prompt(_req(var), var) == "Gmail address"


def test_a_value_keeps_its_own_hint_and_help_link_on_their_own_lines():
    var = SetupVarSpec(env_var="GMAIL_APP_PASSWORD", label="App password", hint="16 letters", help_url=APP_PASSWORDS)
    assert _ask_prompt(_req(var), var).split("\n") == ["Gmail: App password", "16 letters", APP_PASSWORDS]


def test_an_unlabelled_value_names_its_credential():
    var = SetupVarSpec(env_var="TOKEN")
    assert _ask_prompt(_req(var), var) == "Gmail: TOKEN"


def test_the_question_carries_why_the_credential_is_needed():
    var = SetupVarSpec(env_var="GMAIL_ADDRESS", label="Gmail address", secret=False)
    _, ops = compile_setup("p1", [_req(var)], ai=False)
    ask = ops["ask-gmail-GMAIL_ADDRESS"]
    assert ask.exe_data.detail == "Reads your Gmail mail into conversations."


def test_every_shipped_credential_says_what_it_is_needed_for():
    folders = shipped_credential_folders()
    assert folders
    missing = [name for name, folder in folders.items()
               if not str(json.loads((folder / "credential.json").read_text()).get("needed_for", "")).strip()]
    assert not missing, f"credentials with no needed_for: {missing}"
