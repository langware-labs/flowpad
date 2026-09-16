"""The wizard trust boundary: WHERE a wizard lives decides whether its shell
commands run without asking.

This is the gate that keeps "clone a repo and open the project" from being a
code-execution primitive. `.flowpad/bootstrap.json` already attaches content
projects from third-party repos and `repo_assets_fn` indexes everything under
`agentic-assets/`, so an executable asset from an untrusted root is exactly the
thing the rest of the codebase refuses (``CapabilitySpec.install_commands`` is
display-only for the same reason).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.wizard import Wizard

pytestmark = pytest.mark.timeout(5)


def _wizard_at(root: Path) -> Wizard:
    return Wizard(name="w", asset_ref=str(root / "agentic-assets" / "wizard" / "dev-toolchain"))


def test_a_shipped_wizard_is_trusted(tmp_path):
    shipped = tmp_path / "site-packages" / "flow_sdk" / "system_projects" / "flowpad_assistant"
    assert _wizard_at(shipped).is_system() is True


def test_a_wizard_in_an_ordinary_project_is_not(tmp_path):
    assert _wizard_at(tmp_path / "Flowpad workspace" / "cloned-repo").is_system() is False


def test_a_lookalike_path_is_not_trusted(tmp_path):
    """Systemness is structural — ``<install>/flow_sdk/system_projects/<name>``.
    A folder merely NAMED system_projects does not qualify."""
    fake = tmp_path / "system_projects" / "flowpad_assistant"
    assert _wizard_at(fake).is_system() is False


def test_a_wizard_with_no_asset_ref_is_not_trusted():
    assert Wizard(name="w", asset_ref="").is_system() is False


def test_the_shipped_dev_toolchain_wizard_is_trusted_where_it_actually_lives():
    """Guards the real path, so moving the asset cannot silently un-trust it."""
    from flow_sdk.config import system_projects_root

    ref = system_projects_root() / "flowpad_assistant" / "agentic-assets" / "wizard" / "dev-toolchain"
    assert Wizard(name="dev-toolchain", asset_ref=str(ref)).is_system() is True
