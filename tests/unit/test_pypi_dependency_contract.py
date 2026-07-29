"""Packaging constraints that keep a fresh PyPI install importable."""

from pathlib import Path

from packaging.requirements import Requirement
from packaging.version import Version

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib


def _project_requirements() -> dict[str, Requirement]:
    project_root = Path(__file__).resolve().parents[2]
    with (project_root / "pyproject.toml").open("rb") as stream:
        dependencies = tomllib.load(stream)["project"]["dependencies"]
    return {requirement.name: requirement for requirement in map(Requirement, dependencies)}


def test_mcp_dependencies_share_the_v1_protocol():
    requirements = _project_requirements()

    fastmcp = requirements["fastmcp"]
    assert Version("3.0.0") in fastmcp.specifier
    assert Version("4.0.0") not in fastmcp.specifier

    pydantic_ai = requirements["pydantic-ai-slim"]
    assert "mcp" in pydantic_ai.extras
    assert Version("1.62.0") in pydantic_ai.specifier
    assert Version("2.0.0") not in pydantic_ai.specifier
