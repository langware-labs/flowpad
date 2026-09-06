#!/usr/bin/env python3
"""Validate and fingerprint the portable e2e-qa skill package."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any

SCHEMA_VERSION = 1
ALGORITHM = "sha256-path-content-v1"
PACKAGE_ROOT = PurePosixPath(".claude/skills/e2e-qa")

EXPECTED_PATHS = (
    "SKILL.md",
    "agents/bug_fixer.md",
    "agents/qa-tester.md",
    "agents/test_debugger.md",
    "agents/testing_analysis_expert.md",
    "e2e_qa_cleanup.py",
    "examples/sample-cycle-report.json",
    "examples/sample-test-result.json",
    "modes/analyze.md",
    "modes/bug-detector.md",
    "modes/debug.md",
    "modes/qa-cycle.md",
    "modes/reference.md",
    "modes/report.md",
    "modes/run.md",
    "modes/team-setup.md",
    "schemas/cycle-report.schema.json",
    "schemas/test-result.schema.json",
    "templates/report.html",
)

QA_TESTER_TOOLS = (
    "Read",
    "Write",
    "Bash",
    "TaskList",
    "TaskGet",
    "TaskUpdate",
    "SendMessage",
    "mcp__playwright__browser_tabs",
    "mcp__playwright__browser_snapshot",
    "mcp__playwright__browser_click",
    "mcp__playwright__browser_type",
    "mcp__playwright__browser_press_key",
    "mcp__playwright__browser_wait_for",
    "mcp__playwright__browser_navigate",
    "mcp__playwright__browser_resize",
    "mcp__playwright__browser_console_messages",
)

TESTING_ANALYSIS_EXPERT_TOOLS = (
    "Read",
    "Write",
    "Edit",
    "Grep",
    "Glob",
    "Bash",
    "TaskList",
    "TaskGet",
    "TaskUpdate",
    "SendMessage",
    "mcp__playwright__browser_tabs",
    "mcp__playwright__browser_navigate",
    "mcp__playwright__browser_snapshot",
    "mcp__playwright__browser_console_messages",
    "mcp__playwright__browser_click",
    "mcp__playwright__browser_type",
    "mcp__playwright__browser_press_key",
    "mcp__playwright__browser_wait_for",
)

AGENT_TOOL_CONTRACTS = {
    "agents/qa-tester.md": ("qa-tester", QA_TESTER_TOOLS),
    "agents/testing_analysis_expert.md": (
        "testing_analysis_expert",
        TESTING_ANALYSIS_EXPERT_TOOLS,
    ),
}

FORBIDDEN_REFERENCE_PATTERN = re.compile(
    r"debugMcp|Chrome Canary|claude-in-chrome|tabs_create_mcp|\bChrome\b",
    re.IGNORECASE,
)
MCP_TOKEN_PATTERN = re.compile(r"\bmcp__[A-Za-z0-9_]+")

CAP_MARKERS = (
    "5+ minutes",
    "wait up to 45s",
    "--repeat-each=3",
    "`retries` stays 0",
    "wait 2s and retry once",
    "10s",
    "exceeds 15s",
)
CAP_PATTERNS = (
    ("team size at most three", re.compile(r"up to (?:the existing maximum of )?(?:3|three)")),
    ("one tester for debug/validate", re.compile(r"1 for debug/validate")),
)

LIFECYCLE_DOCUMENTS = (
    "agents/qa-tester.md",
    "modes/team-setup.md",
)
LIFECYCLE_PATTERNS = (
    ("task tab index", re.compile(r"MY_TASK_TAB_INDEX")),
    ("new tab action", re.compile(r'browser_tabs\(action="new"')),
    ("select tab action", re.compile(r'browser_tabs\(action="select"')),
    (
        "close task tab",
        re.compile(r'browser_tabs\(action="close", index=MY_TASK_TAB_INDEX\)'),
    ),
    (
        "exclusive browser-owner boundary",
        re.compile(r"one browser owner at a time per \{Playwright MCP server process, Flowpad instance\}"),
    ),
    ("shared-context prohibition", re.compile(r"--shared-browser-context")),
    ("distinct Flowpad instance", re.compile(r"distinct named Flowpad")),
    ("private output directory", re.compile(r"private Playwright/result output directory")),
    ("serialized fallback", re.compile(r"serializ")),
)

REQUIRED_STANDARD_CALL_MARKERS = (
    "browser_click(target=",
    "browser_type(target=",
    "text=",
    "browser_press_key(key=",
)

OBSOLETE_CALL_PATTERNS = (
    ("browser_wait_for timeout argument", re.compile(r"browser_wait_for\([^)]*\btimeout\s*=", re.DOTALL)),
    ("browser_click ref argument", re.compile(r"browser_click\(\s*ref\b")),
    ("browser_type ref argument", re.compile(r"browser_type\(\s*ref\b")),
    ("browser_press_key key_name argument", re.compile(r"browser_press_key\(\s*key_name\b")),
)


class RepositoryError(RuntimeError):
    """The requested package source could not be read from Git or disk."""


def _sort_paths(paths: Sequence[str]) -> list[str]:
    return sorted(paths, key=lambda path: path.encode("utf-8"))


def parse_frontmatter(document: str) -> dict[str, str]:
    """Parse the flat key/value frontmatter used by the package's agents."""
    lines = document.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("missing opening frontmatter delimiter")

    fields: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            return fields
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            raise ValueError(f"invalid frontmatter line: {line!r}")
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip()
    raise ValueError("missing closing frontmatter delimiter")


def parse_tool_sequence(document: str) -> tuple[str, tuple[str, ...]]:
    fields = parse_frontmatter(document)
    name = fields.get("name", "")
    tools = tuple(tool.strip() for tool in fields.get("tools", "").split(",") if tool.strip())
    return name, tools


def package_manifest(files: Mapping[str, bytes]) -> tuple[list[dict[str, Any]], str]:
    """Return per-file metadata and the sha256-path-content-v1 digest."""
    entries: list[dict[str, Any]] = []
    manifest = bytearray()
    for path in _sort_paths(list(files)):
        content = files[path]
        file_sha256 = hashlib.sha256(content).hexdigest()
        entries.append(
            {
                "path": path,
                "size_bytes": len(content),
                "sha256": file_sha256,
            }
        )
        manifest.extend(path.encode("utf-8"))
        manifest.append(0)
        manifest.extend(file_sha256.encode("ascii"))
        manifest.append(10)
    return entries, hashlib.sha256(manifest).hexdigest()


def validate_package(files: Mapping[str, bytes]) -> list[str]:
    """Validate a mapping of package-relative POSIX paths to exact bytes."""
    errors: list[str] = []
    actual_paths = set(files)
    expected_paths = set(EXPECTED_PATHS)

    missing = _sort_paths(list(expected_paths - actual_paths))
    extra = _sort_paths(list(actual_paths - expected_paths))
    if missing:
        errors.append(f"missing package paths: {', '.join(missing)}")
    if extra:
        errors.append(f"unexpected package paths: {', '.join(extra)}")

    documents: dict[str, str] = {}
    for path in _sort_paths(list(actual_paths)):
        try:
            documents[path] = files[path].decode("utf-8")
        except UnicodeDecodeError:
            errors.append(f"{path}: package files must be UTF-8")

    all_text = "\n".join(documents.values())
    forbidden = sorted(set(FORBIDDEN_REFERENCE_PATTERN.findall(all_text)), key=str.casefold)
    if forbidden:
        errors.append(f"forbidden browser references: {', '.join(forbidden)}")

    invalid_mcp_tokens = sorted(
        {token for token in MCP_TOKEN_PATTERN.findall(all_text) if not token.startswith("mcp__playwright__")}
    )
    if invalid_mcp_tokens:
        errors.append(f"non-Playwright MCP tools: {', '.join(invalid_mcp_tokens)}")

    for path, (expected_name, expected_tools) in AGENT_TOOL_CONTRACTS.items():
        document = documents.get(path)
        if document is None:
            continue
        try:
            name, tools = parse_tool_sequence(document)
        except ValueError as exc:
            errors.append(f"{path}: invalid frontmatter: {exc}")
            continue
        if name != expected_name:
            errors.append(f"{path}: expected frontmatter name {expected_name!r}, got {name!r}")
        if tools != expected_tools:
            errors.append(f"{path}: tools do not match the ordered portable contract")

    for path in LIFECYCLE_DOCUMENTS:
        document = documents.get(path)
        if document is None:
            continue
        for label, pattern in LIFECYCLE_PATTERNS:
            if not pattern.search(document):
                errors.append(f"{path}: missing lifecycle/isolation marker {label!r}")

    qa_tester = documents.get("agents/qa-tester.md", "")
    for marker in REQUIRED_STANDARD_CALL_MARKERS:
        if marker not in qa_tester:
            errors.append(f"agents/qa-tester.md: missing standard tool-call marker {marker!r}")

    for label, pattern in OBSOLETE_CALL_PATTERNS:
        matches = [path for path, document in documents.items() if pattern.search(document)]
        if matches:
            errors.append(f"obsolete {label} in: {', '.join(_sort_paths(matches))}")

    for marker in CAP_MARKERS:
        if marker not in all_text:
            errors.append(f"missing fixed cap marker: {marker!r}")
    for label, pattern in CAP_PATTERNS:
        if not pattern.search(all_text):
            errors.append(f"missing fixed cap marker: {label!r}")

    return errors


def build_report(
    files: Mapping[str, bytes],
    *,
    source_kind: str,
    revision: str | None,
    errors: Sequence[str] | None = None,
) -> dict[str, Any]:
    manifest_files, package_sha256 = package_manifest(files)
    validation_errors = list(errors) if errors is not None else validate_package(files)
    return {
        "schema_version": SCHEMA_VERSION,
        "algorithm": ALGORITHM,
        "valid": not validation_errors,
        "source": {"kind": source_kind, "revision": revision},
        "package_root": str(PACKAGE_ROOT),
        "file_count": len(files),
        "files": manifest_files,
        "package_sha256": package_sha256,
        "errors": validation_errors,
    }


def _git(repo_root: Path, *args: str) -> bytes:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=repo_root,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise RepositoryError("git executable not found") from exc
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", errors="replace").strip()
        command = " ".join(("git", *args))
        raise RepositoryError(f"{command} failed: {detail or f'exit {exc.returncode}'}") from exc
    return completed.stdout


def resolve_repo_root(cwd: Path) -> Path:
    output = _git(cwd, "rev-parse", "--show-toplevel")
    return Path(output.decode("utf-8").strip()).resolve()


def read_worktree_package(repo_root: Path) -> dict[str, bytes]:
    output = _git(repo_root, "ls-files", "-z", "--", str(PACKAGE_ROOT))
    package: dict[str, bytes] = {}
    prefix = f"{PACKAGE_ROOT}/"
    for repo_path in filter(None, output.decode("utf-8").split("\0")):
        if not repo_path.startswith(prefix):
            raise RepositoryError(f"unexpected Git path outside package: {repo_path}")
        relative_path = repo_path.removeprefix(prefix)
        try:
            package[relative_path] = (repo_root / repo_path).read_bytes()
        except OSError as exc:
            raise RepositoryError(f"cannot read worktree file {repo_path}: {exc}") from exc
    return package


def read_tree_package(repo_root: Path, revision: str) -> tuple[str, dict[str, bytes]]:
    resolved = _git(repo_root, "rev-parse", "--verify", f"{revision}^{{commit}}")
    commit_sha = resolved.decode("ascii").strip()
    output = _git(
        repo_root,
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        commit_sha,
        "--",
        str(PACKAGE_ROOT),
    )
    package: dict[str, bytes] = {}
    prefix = f"{PACKAGE_ROOT}/"
    for repo_path in filter(None, output.decode("utf-8").split("\0")):
        if not repo_path.startswith(prefix):
            raise RepositoryError(f"unexpected Git-tree path outside package: {repo_path}")
        relative_path = repo_path.removeprefix(prefix)
        package[relative_path] = _git(repo_root, "show", f"{commit_sha}:{repo_path}")
    return commit_sha, package


def _empty_error_report(source_kind: str, error: str) -> dict[str, Any]:
    return build_report(
        {},
        source_kind=source_kind,
        revision=None,
        errors=[error],
    )


def _print_human(report: Mapping[str, Any]) -> None:
    source = report["source"]
    revision = f" {source['revision']}" if source["revision"] else ""
    lines = (
        f"source: {source['kind']}{revision}",
        f"files: {report['file_count']}",
        f"algorithm: {report['algorithm']}",
        f"package_sha256: {report['package_sha256']}",
        f"valid: {str(report['valid']).lower()}",
    )
    sys.stdout.write("\n".join(lines) + "\n")
    if report["errors"]:
        sys.stderr.write("".join(f"error: {error}\n" for error in report["errors"]))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument(
        "--worktree",
        action="store_true",
        help="validate current tracked worktree bytes (default)",
    )
    source.add_argument("--tree", metavar="REV", help="validate package blobs from a Git commit")
    parser.add_argument("--json", action="store_true", help="emit one JSON object to stdout")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    source_kind = "git-tree" if args.tree else "worktree"
    try:
        repo_root = resolve_repo_root(Path.cwd())
        if args.tree:
            revision, files = read_tree_package(repo_root, args.tree)
        else:
            revision = None
            files = read_worktree_package(repo_root)
        report = build_report(files, source_kind=source_kind, revision=revision)
        exit_code = 0 if report["valid"] else 1
    except RepositoryError as exc:
        report = _empty_error_report(source_kind, str(exc))
        exit_code = 2

    if args.json:
        sys.stdout.write(json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n")
    else:
        _print_human(report)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
