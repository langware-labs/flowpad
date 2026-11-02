"""A secret manager's setup wizard for one vault, built from its own manifest (``flow secrets setup <vault>``)."""
from __future__ import annotations

from flow_sdk.schema.data_spec.secret_vault_spec import SecretVaultSpec
from flow_sdk.secrets.errors import StoreToolMissing
from flow_sdk.secrets.setup_wizard import store_why, vault_setup_wizard

VAULT = SecretVaultSpec(manager="onepassword", config={"vault": "GTM Studio", "account": "acme.1password.com"})


def test_a_vault_name_with_a_space_is_one_argument_on_every_os():
    _, ops = vault_setup_wizard("p1", "team", VAULT)
    check = {p: ops["vault:team:login"].completion_check.command_for(p) for p in ("darwin", "win32")}
    assert check["darwin"] == "OP_ACCOUNT=acme.1password.com op vault get 'GTM Studio' --format json"
    assert check["win32"] == 'set OP_ACCOUNT=acme.1password.com&& op vault get "GTM Studio" --format json'


def test_the_wizard_installs_signs_in_then_checks_the_vault():
    wizard, ops = vault_setup_wizard("p1", "team", VAULT)
    assert [s.id for s in wizard.steps] == ["install", "login", "check"]
    # The install is done once the manager's tool is on PATH — the tool, not the env prefix before it.
    assert ops["vault:team:install"].completion_check.command_for("darwin") == "command -v op >/dev/null 2>&1"
    assert ops["vault:team:login"].completion_check.command_for("darwin").startswith("OP_ACCOUNT=acme.1password.com op vault get")
    assert "secrets check team --project p1" in ops["vault:team:check"].exe_data.command_for("darwin")


def test_why_a_vault_cannot_be_read_names_the_command_that_fixes_it():
    why = store_why(StoreToolMissing("the 1Password CLI (`op`) is not installed on this machine"), "team")
    assert why == "vault team cannot be read here: the 1Password CLI (`op`) is not installed on this machine — run `flow secrets setup team`"


def test_the_1password_manager_says_what_to_click_when_sign_in_fails():
    from flow_sdk.secrets.managers import get_manager

    assert "Integrate with 1Password CLI" in get_manager("onepassword").login_help
