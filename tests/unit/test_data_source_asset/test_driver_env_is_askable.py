"""Every environment variable a shipped driver reads is declared by a shipped credential.

A source's Set up asks a person only for what a credential declares (label, hint, secret or not); a
variable no credential owns is a gap — reported, never asked for — and the source can never leave
setup from the app. Read off the shipped files alone: no DB, no index.
"""
from __future__ import annotations

import json

from tests.unit.test_credential_asset._shipped import SHIPPED_PROJECT, shipped_credential_folders


def _document(path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_every_env_variable_of_a_shipped_driver_has_a_credential_that_declares_it():
    declared = {
        var for folder in shipped_credential_folders().values() for var in _document(folder / "credential.json").get("vars") or {}
    }
    drivers = [_document(path) for path in sorted(SHIPPED_PROJECT.glob("data_driver/*/data_driver.json"))]
    assert drivers and declared

    unowned = {
        doc["name"]: missing
        for doc in drivers
        if (missing := [var for var in (doc.get("auth") or {}).get("env") or [] if var not in declared])
    }

    assert unowned == {}
