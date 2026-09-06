from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

import scripts.validate_e2e_qa_package as validator

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "validate_e2e_qa_package.py"


@pytest.fixture
def canonical_files() -> dict[str, bytes]:
    return validator.read_worktree_package(REPO_ROOT)


def _write_package(repo: Path, files: dict[str, bytes]) -> None:
    package_root = repo / validator.PACKAGE_ROOT
    for relative_path, content in files.items():
        destination = package_root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)


def _git(repo: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return completed.stdout.strip()


def _init_committed_package(repo: Path, files: dict[str, bytes]) -> str:
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "qa-validator@local.test")
    _git(repo, "config", "user.name", "QA Validator")
    _write_package(repo, files)
    _git(repo, "add", str(validator.PACKAGE_ROOT))
    _git(repo, "commit", "-qm", "canonical package")
    return _git(repo, "rev-parse", "HEAD")


def _run_cli(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=repo,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _replace(files: dict[str, bytes], path: str, old: bytes, new: bytes) -> None:
    assert old in files[path]
    files[path] = files[path].replace(old, new, 1)


def test_canonical_worktree_contract(canonical_files: dict[str, bytes]) -> None:
    assert set(canonical_files) == set(validator.EXPECTED_PATHS)
    assert validator.validate_package(canonical_files) == []

    for path, (expected_name, expected_tools) in validator.AGENT_TOOL_CONTRACTS.items():
        name, tools = validator.parse_tool_sequence(canonical_files[path].decode())
        assert (name, tools) == (expected_name, expected_tools)

    report = validator.build_report(
        canonical_files,
        source_kind="worktree",
        revision=None,
    )
    assert report["valid"] is True
    assert report["file_count"] == 19
    assert [entry["path"] for entry in report["files"]] == sorted(
        validator.EXPECTED_PATHS,
        key=lambda path: path.encode(),
    )


@pytest.mark.parametrize(
    ("case", "error_fragment"),
    [
        ("forbidden_namespace", "forbidden browser references"),
        ("wrong_frontmatter_tool", "tools do not match"),
        ("missing_file", "missing package paths"),
        ("tracked_cache", "unexpected package paths"),
        ("stale_call", "browser_wait_for timeout argument"),
        ("missing_cap", "missing fixed cap marker"),
        ("missing_isolation", "missing lifecycle/isolation marker"),
    ],
)
def test_contract_rejection_table(
    canonical_files: dict[str, bytes],
    case: str,
    error_fragment: str,
) -> None:
    files = dict(canonical_files)
    if case == "forbidden_namespace":
        _replace(files, "agents/qa-tester.md", b"mcp__playwright__", b"mcp__debugMcp__")
    elif case == "wrong_frontmatter_tool":
        _replace(files, "agents/qa-tester.md", b"tools: Read, Write, Bash", b"tools: Read, Glob, Bash")
    elif case == "missing_file":
        files.pop("examples/sample-test-result.json")
    elif case == "tracked_cache":
        files["__pycache__/e2e_qa_cleanup.cpython-313.pyc"] = b"cache"
    elif case == "stale_call":
        files["agents/qa-tester.md"] += b'\nbrowser_wait_for(text="ready", timeout=10)\n'
    elif case == "missing_cap":
        _replace(files, "agents/qa-tester.md", b"5+ minutes", b"five minutes")
    elif case == "missing_isolation":
        _replace(
            files,
            "modes/team-setup.md",
            b"one browser owner at a time per {Playwright MCP server process, Flowpad instance}",
            b"one browser owner",
        )
    else:  # pragma: no cover - parametrization is exhaustive
        raise AssertionError(case)

    errors = validator.validate_package(files)
    assert any(error_fragment in error for error in errors), errors


def test_digest_is_deterministic_and_path_content_sensitive(
    canonical_files: dict[str, bytes],
) -> None:
    _, canonical_digest = validator.package_manifest(canonical_files)
    reversed_files = dict(reversed(list(canonical_files.items())))
    _, reordered_digest = validator.package_manifest(reversed_files)
    assert reordered_digest == canonical_digest

    changed_content = dict(canonical_files)
    changed_content["SKILL.md"] += b"\nchanged\n"
    assert validator.package_manifest(changed_content)[1] != canonical_digest

    changed_path = dict(canonical_files)
    changed_path["renamed-SKILL.md"] = changed_path.pop("SKILL.md")
    assert validator.package_manifest(changed_path)[1] != canonical_digest


def test_git_tree_isolation_from_modified_worktree(
    tmp_path: Path,
    canonical_files: dict[str, bytes],
) -> None:
    repo = tmp_path / "package-repo"
    commit_sha = _init_committed_package(repo, canonical_files)
    skill_path = repo / validator.PACKAGE_ROOT / "SKILL.md"
    skill_path.write_bytes(skill_path.read_bytes() + b"\nuncommitted change\n")

    tree_result = _run_cli(repo, "--tree", "HEAD", "--json")
    worktree_result = _run_cli(repo, "--json")
    assert tree_result.returncode == worktree_result.returncode == 0

    tree_report = json.loads(tree_result.stdout)
    worktree_report = json.loads(worktree_result.stdout)
    assert tree_report["source"] == {"kind": "git-tree", "revision": commit_sha}
    assert worktree_report["source"] == {"kind": "worktree", "revision": None}
    assert tree_report["package_sha256"] != worktree_report["package_sha256"]

    committed_files = dict(canonical_files)
    assert tree_report["package_sha256"] == validator.package_manifest(committed_files)[1]


def test_cli_json_contract_and_explicit_worktree(
    tmp_path: Path,
    canonical_files: dict[str, bytes],
) -> None:
    repo = tmp_path / "package-repo"
    _init_committed_package(repo, canonical_files)

    default_result = _run_cli(repo, "--json")
    explicit_result = _run_cli(repo, "--worktree", "--json")
    assert default_result.returncode == explicit_result.returncode == 0
    assert default_result.stderr == explicit_result.stderr == ""
    assert json.loads(default_result.stdout) == json.loads(explicit_result.stdout)

    report = json.loads(default_result.stdout)
    assert set(report) == {
        "schema_version",
        "algorithm",
        "valid",
        "source",
        "package_root",
        "file_count",
        "files",
        "package_sha256",
        "errors",
    }
    assert report["schema_version"] == 1
    assert report["algorithm"] == "sha256-path-content-v1"
    assert report["source"] == {"kind": "worktree", "revision": None}
    assert report["package_root"] == ".claude/skills/e2e-qa"
    assert report["file_count"] == 19
    assert report["valid"] is True
    assert report["errors"] == []
    assert len(report["package_sha256"]) == 64
    assert all(set(entry) == {"path", "size_bytes", "sha256"} for entry in report["files"])

    mutually_exclusive = _run_cli(repo, "--worktree", "--tree", "HEAD", "--json")
    assert mutually_exclusive.returncode == 2


def test_cli_invalid_contract_and_revision_exit_codes(
    tmp_path: Path,
    canonical_files: dict[str, bytes],
) -> None:
    repo = tmp_path / "package-repo"
    _init_committed_package(repo, canonical_files)
    tester = repo / validator.PACKAGE_ROOT / "agents/qa-tester.md"
    tester.write_bytes(tester.read_bytes() + b"\nDebugMCP\n")

    invalid_content = _run_cli(repo, "--json")
    assert invalid_content.returncode == 1
    assert invalid_content.stderr == ""
    invalid_report = json.loads(invalid_content.stdout)
    assert invalid_report["valid"] is False
    assert invalid_report["errors"]

    invalid_revision = _run_cli(repo, "--tree", "not-a-revision", "--json")
    assert invalid_revision.returncode == 2
    assert invalid_revision.stderr == ""
    revision_report = json.loads(invalid_revision.stdout)
    assert revision_report["valid"] is False
    assert revision_report["source"] == {"kind": "git-tree", "revision": None}
    assert revision_report["errors"]
