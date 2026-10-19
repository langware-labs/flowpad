"""``migration_2026_09_credential_noun``: a declared ``secret_pack/<name>`` folder becomes
``credential/<name>/credential.json`` with its identity, an existing ``credential/<name>`` is a reported
conflict, a leftover that no longer parses is reported, an authored driver's ``Credentials`` import is
rewritten, and a second run changes nothing."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.migrations.migration_2026_09_credential_noun import migrate

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

PACK = {"name": "stripe", "schema": 2, "vars": {"STRIPE_KEY": {"label": "key"}}, "setup": "Store it."}
DRIVER = '''from flow_sdk.sources import Credentials
from flow_sdk.sources.families import RecordSource


class QuakeSource(RecordSource):
    provider = "quake"

    def keyed(self, credentials: Credentials) -> bool:
        return bool(credentials.values)
'''


def _pack(root: Path, family: str, name: str, main: str, body: dict) -> Path:
    folder = root / "agentic-assets" / family / name
    (folder / ".flow" / "capsules").mkdir(parents=True)
    (folder / main).write_text(json.dumps({**body, "name": name}))
    (folder / ".flow" / "capsules" / "identity.json").write_text('{"id": "4b1c2d3e-5f60-4a7b-8c9d-0e1f2a3b4c5d"}')
    return folder


def test_a_declared_folder_moves_and_a_second_run_is_a_no_op(tmp_path):
    _pack(tmp_path, "secret_pack", "stripe", "secret_pack.json", PACK)
    _pack(tmp_path, "secret_pack", "clash", "secret_pack.json", PACK)
    _pack(tmp_path, "credential", "clash", "credential.json", PACK)
    _pack(tmp_path, "credential", "ancient", "credential.json", {"vars": {"X": {}}, "schema": 1})
    driver = tmp_path / "agentic-assets" / "data_driver" / "quake"
    driver.mkdir(parents=True)
    (driver / "source.py").write_text(DRIVER)
    (driver / "data_driver.json").write_text(json.dumps({"name": "quake", "schema": 2}))

    dry = migrate(dry_run=True, roots=[tmp_path])
    assert [Path(p).name for p in dry.moved] == ["stripe"] and not (tmp_path / "agentic-assets/credential/stripe").exists()

    applied = migrate(dry_run=False, roots=[tmp_path])

    moved = tmp_path / "agentic-assets" / "credential" / "stripe"
    assert json.loads((moved / "credential.json").read_text())["name"] == "stripe"
    assert (moved / ".flow" / "capsules" / "identity.json").is_file(), "the identity travels with the folder"
    assert [Path(p).name for p in applied.conflicts] == ["clash"]
    assert (tmp_path / "agentic-assets" / "secret_pack" / "clash" / "secret_pack.json").is_file(), "never overwritten"
    assert [Path(p).name for p in applied.unreadable] == ["ancient"]
    assert "ResolvedSecrets" in (driver / "source.py").read_text() and "Credentials" not in (driver / "source.py").read_text()

    again = migrate(dry_run=False, roots=[tmp_path])
    assert again.moved == [] and again.drivers_rewritten == [] and not again.changed
