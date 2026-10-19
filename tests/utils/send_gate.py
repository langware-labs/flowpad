"""Pin the add_message send gate for a test: not Local mode, no cloud login.

A send then persists locally as ``pending_send`` with no hub involved — deterministic, and
everything a thread does on this machine (resolve, stamp, count) still happens.
"""
from __future__ import annotations


def logged_out(monkeypatch) -> None:
    monkeypatch.setattr("flow_sdk.instance_settings.privacy_mode.is_local_mode", lambda: False)
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.is_logged_in", lambda: False)
    # ``notification_action`` binds ``is_logged_in`` at import, so patch it there too.
    monkeypatch.setattr("flow_sdk.app.actions.notification_action.is_logged_in", lambda: False)
