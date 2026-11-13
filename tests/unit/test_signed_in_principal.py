"""The instance stores WHO it is signed in as: a person (``user``) or an agent's Identity (``identity``).

``get_user()`` answers the person only, so nothing that needs a person mistakes an agent for one; a login
record written before the principal existed (the hub's user-shaped projection) still reads as what it was.
"""

from flow_sdk.cli import app_config
from flow_sdk.cli.auth.hub_login import is_logged_in

AGENT = {"id": "4f3c", "type": "identity", "name": "Support bot", "subject_typeid": "agent-9"}


def _config(tmp_path, monkeypatch):
    monkeypatch.setattr(app_config, "_config_file_path", lambda: tmp_path / "config.json")


def test_an_agent_login_is_a_principal_and_no_user(tmp_path, monkeypatch):
    _config(tmp_path, monkeypatch)
    app_config.set_principal(AGENT)

    assert app_config.get_principal()["typeid"] == "identity-4f3c"
    assert app_config.get_user() is None
    assert is_logged_in()


def test_a_person_is_both(tmp_path, monkeypatch):
    _config(tmp_path, monkeypatch)
    app_config.set_user({"id": "u1", "email": "a@b.c"})

    assert app_config.get_principal()["typeid"] == "user-u1"
    assert app_config.get_user()["email"] == "a@b.c"


def test_a_record_from_before_the_principal_reads_as_what_it_was(tmp_path, monkeypatch):
    _config(tmp_path, monkeypatch)
    app_config.set_config("user", {"id": "4f3c", "typeid": "user-4f3c", "type": "user", "is_identity": True})

    assert app_config.get_principal()["typeid"] == "identity-4f3c"
    assert app_config.get_user() is None


def test_signing_out_clears_it(tmp_path, monkeypatch):
    _config(tmp_path, monkeypatch)
    app_config.set_principal(AGENT)
    app_config.clear_user()

    assert app_config.get_principal() is None and not is_logged_in()
