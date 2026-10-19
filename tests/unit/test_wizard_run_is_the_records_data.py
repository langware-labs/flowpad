"""A wizard's run is that wizard RECORD's data, on this instance -- never a machine-wide file.

It once lived in a machine-wide folder under the shared flow home, and a shipped wizard has the
same id on every instance, so every instance on a machine read and overwrote one run: a fresh
instance's first-run setup opened onto another instance's answers (the first-run e2e saw
"satisfied" before Start was pressed), and a test run clobbered prod's.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.core.wizard.state import read_result, record_result, run_dir, run_key
from flow_sdk.fs_store import record_paths
from flow_sdk.schema.data_spec.returned_value_spec import WizardResult

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

WIZARD = "40b630c9-62dd-4ecf-a4f9-bcbce54e7dde"


@pytest.fixture
def instance(monkeypatch, tmp_path):
    """Switch which instance's records_data the wizard state lives in."""

    def use(name: str) -> Path:
        root = tmp_path / name / "records_data"
        monkeypatch.setattr(record_paths, "get_default_records_data_root", lambda: root)
        return root

    return use


def test_the_run_lives_in_the_wizard_records_data_folder(instance):
    root = instance("a")

    assert run_dir(WIZARD) == root / "wizard" / WIZARD
    assert run_dir(run_key(WIZARD, "data_source:abc")) == root / "wizard" / WIZARD / "data_source_abc"


def test_one_instances_run_is_invisible_to_another(instance):
    instance("a")
    record_result(WIZARD, WizardResult.satisfied("setup done on a"))

    instance("b")
    assert read_result(WIZARD) is None, "a fresh instance must not open onto another instance's run"

    instance("a")
    assert read_result(WIZARD) is not None
