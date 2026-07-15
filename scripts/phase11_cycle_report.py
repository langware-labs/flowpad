#!/usr/bin/env python3
# ruff: noqa: T201 -- this command-line helper intentionally emits scalar/JSON data
"""Fail-closed helpers for the Phase 11 Playwright sweep.

The shell runner owns orchestration.  This module owns the parts that are easy
to get subtly wrong in shell: safe named-instance discovery, HTTP response
validation, recursive Playwright JSON traversal, resumability checks, and the
final machine-readable gate.

There are deliberately no retry loops, sleeps, polling helpers, or caller-set
timeouts here.  An unavailable dependency is an infrastructure failure, not a
reason to widen a waiting budget.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

MAX_TEST_DURATION_MS = 60_000
BAD_RESULT_STATUSES = {"failed", "timedOut", "interrupted"}
ALLOWED_RESULT_STATUSES = {"passed", "skipped"}
ALLOWED_SKIP_PREFIXES = {
    "clipboard": ("clipboard:", "[skip:clipboard]"),
    "live-claude": ("live-claude:", "[skip:live-claude]"),
    "wrong-platform": (
        "platform:",
        "wrong-platform:",
        "[skip:platform]",
        "[skip:wrong-platform]",
    ),
}


class Phase11Error(RuntimeError):
    """A fail-closed runner/configuration error safe to print to stderr."""


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _load_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise Phase11Error(f"{label} is missing") from exc
    except (OSError, json.JSONDecodeError, UnicodeError) as exc:
        raise Phase11Error(f"{label} is not parseable JSON") from exc


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalize_url(value: Any) -> str:
    return value.rstrip("/") if isinstance(value, str) else ""


def _parse_dotenv(path: Path) -> dict[str, str]:
    """Parse generated instance env data without ever executing/sourcing it."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise Phase11Error(f"generated instance env is unavailable: {path.name}") from exc

    values: dict[str, str] = {}
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise Phase11Error(f"malformed generated instance env line {path.name}:{number}")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise Phase11Error(f"unsafe generated instance env key in {path.name}:{number}")
        if key in values:
            raise Phase11Error(f"duplicate generated instance env key {key} in {path.name}")
        if len(value) >= 2 and value[:1] == value[-1:] and value[0] in "'\"":
            value = value[1:-1]
        if "\x00" in value or "\n" in value or "\r" in value:
            raise Phase11Error(f"unsafe generated instance env value for {key}")
        values[key] = value
    return values


def _require_env_value(env: dict[str, str], key: str, label: str) -> str:
    value = env.get(key, "")
    if not value:
        raise Phase11Error(f"{label} generated env is missing {key}")
    return value


def _request_bytes(url: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> bytes:
    data = None
    headers: dict[str, str] = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    try:
        with urlopen(Request(url, data=data, headers=headers, method=method)) as response:
            if response.status != 200:
                raise Phase11Error(f"HTTP preflight returned status {response.status}")
            return response.read()
    except HTTPError as exc:
        raise Phase11Error(f"HTTP preflight returned status {exc.code}") from exc
    except (URLError, OSError) as exc:
        raise Phase11Error("HTTP preflight dependency is unreachable") from exc


def _request_json(url: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
    raw = _request_bytes(url, method=method, body=body)
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise Phase11Error("HTTP preflight response is not JSON") from exc
    if not isinstance(payload, dict):
        raise Phase11Error("HTTP preflight JSON is not an object")
    return payload


def _response_data(payload: dict[str, Any], label: str) -> dict[str, Any]:
    if payload.get("status") not in (None, "SUCCESS"):
        raise Phase11Error(f"{label} returned a non-success response")
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        raise Phase11Error(f"{label} returned an invalid data envelope")
    return data


def _validate_bootstrap(api_url: str) -> int:
    payload = _request_json(f"{api_url}/api/v1/graph/bootstrap")
    data = _response_data(payload, "backend bootstrap")
    types = data.get("types")
    if not isinstance(types, (list, dict)) or not types:
        raise Phase11Error("backend bootstrap has no populated type registry")
    return len(types)


def _validate_cloud_status(
    api_url: str,
    email: str,
    hub_url: str,
    expected_user_id: str | None = None,
) -> dict[str, Any]:
    data = _response_data(
        _request_json(f"{api_url}/api/v1/cloud/status"),
        "backend cloud status",
    )
    user = data.get("user")
    login = data.get("login")
    if data.get("logged_in") is not True:
        raise Phase11Error("backend cloud status is not logged in")
    if not isinstance(user, dict) or user.get("email") != email:
        raise Phase11Error("backend cloud status identity does not match generated env")
    if expected_user_id is not None and user.get("id") != expected_user_id:
        raise Phase11Error("backend cloud status user id does not match hub login")
    if not isinstance(login, dict) or login.get("status") != "logged_in":
        raise Phase11Error("backend canonical cloud login status is not logged_in")
    if data.get("hub_ws_connected") is not True or data.get("hub_ws_verified") is not True:
        raise Phase11Error("backend hub WebSocket is not connected and verified")
    expected_cloud_url = f"{_normalize_url(hub_url)}/api/v1"
    if _normalize_url(data.get("cloud_url")) != expected_cloud_url:
        raise Phase11Error("backend cloud URL does not match the explicit hub")
    return {
        "logged_in": True,
        "email": email,
        "hub_ws_connected": True,
        "hub_ws_verified": True,
        "cloud_url": expected_cloud_url,
    }


def _connect_and_validate_hub_ws(api_url: str, expected_user_id: str) -> dict[str, Any]:
    """Perform the one explicit WS connect/verify transition used by preflight."""
    data = _response_data(
        _request_json(
            f"{_normalize_url(api_url)}/api/v1/cloud/ws/connect",
            method="POST",
        ),
        "backend hub WebSocket connect",
    )
    verification = data.get("verification")
    if (
        data.get("hub_ws_connected") is not True
        or data.get("hub_ws_verified") is not True
        or data.get("hub_ws_status") != "verified"
    ):
        raise Phase11Error("backend hub WebSocket connect did not reach verified status")
    if (
        not isinstance(verification, dict)
        or verification.get("verified") is not True
        or verification.get("local_user_id") != expected_user_id
        or verification.get("hub_user_id") != expected_user_id
    ):
        raise Phase11Error("backend hub WebSocket verification identity does not match hub login")
    return {
        "hub_ws_connected": True,
        "hub_ws_verified": True,
        "hub_ws_status": "verified",
        "user_id": expected_user_id,
    }


def _hub_login(hub_url: str, email: str, password: str) -> dict[str, str]:
    data = _response_data(
        _request_json(
            f"{_normalize_url(hub_url)}/api/v1/login",
            method="POST",
            body={"email": email, "password": password},
        ),
        "hub login",
    )
    token = data.get("api_key") or data.get("token")
    user = data.get("user")
    if not isinstance(token, str) or not token:
        raise Phase11Error("hub login returned no bearer credential")
    if not isinstance(user, dict) or user.get("email") != email:
        raise Phase11Error("hub login identity does not match generated env")
    user_id = user.get("id")
    if not isinstance(user_id, str) or not user_id:
        raise Phase11Error("hub login returned no user id")
    # Do not return, persist, or print the bearer credential.
    return {"id": user_id, "email": email}


def _pid_is_live(value: Any) -> bool:
    if not isinstance(value, int) or value <= 0:
        return False
    try:
        os.kill(value, 0)
    except OSError:
        return False
    return True


def _resolve_instance(
    *,
    repo: Path,
    flow_home: Path,
    name: str,
    hub_url: str,
    role: str,
) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name):
        raise Phase11Error(f"unsafe {role} instance name")
    env_path = repo / f".env.{name}.local"
    env = _parse_dotenv(env_path)
    if _require_env_value(env, "FLOW_INSTANCE", role) != name:
        raise Phase11Error(f"{role} generated env targets a different instance")
    be_text = _require_env_value(env, "LOCAL_SERVER_PORT", role)
    fe_text = _require_env_value(env, "VITE_PORT", role)
    if not be_text.isdigit() or not fe_text.isdigit():
        raise Phase11Error(f"{role} generated env has an invalid port")
    backend_port, frontend_port = int(be_text), int(fe_text)
    api_url = f"http://localhost:{backend_port}"
    app_url = f"http://localhost:{frontend_port}"
    if env.get("VITE_API_URL") != api_url:
        raise Phase11Error(f"{role} generated env VITE_API_URL does not match its backend")
    if _normalize_url(env.get("FLOWPAD_HUB_URL")) != _normalize_url(hub_url):
        raise Phase11Error(f"{role} generated env targets a different hub")
    if env.get("FLOWPAD_SKIP_DOTENV") != "true" or env.get("MINIHUB_RELOAD") != "False":
        raise Phase11Error(f"{role} generated env is not isolated from repo dotenv/reload")
    email = _require_env_value(env, "FLOWPAD_CLOUD_USER_EMAIL", role)
    password = _require_env_value(env, "FLOWPAD_CLOUD_USER_PASSWORD", role)

    launcher_path = flow_home / "instances" / name / "launcher.json"
    launcher = _load_json(launcher_path, f"{role} launcher registry")
    if not isinstance(launcher, dict):
        raise Phase11Error(f"{role} launcher registry is not an object")
    expected_env_path = env_path.resolve()
    try:
        launcher_env_path = Path(str(launcher.get("env_file", ""))).resolve()
    except OSError as exc:
        raise Phase11Error(f"{role} launcher env path is invalid") from exc
    checks = (
        launcher.get("name") == name,
        launcher.get("backend_port") == backend_port,
        launcher.get("frontend_port") == frontend_port,
        _normalize_url(launcher.get("hub_url")) == _normalize_url(hub_url),
        launcher.get("email") == email,
        launcher_env_path == expected_env_path,
        _pid_is_live(launcher.get("backend_pid")),
        _pid_is_live(launcher.get("frontend_pid")),
    )
    if not all(checks):
        raise Phase11Error(f"{role} launcher registry is stale or mismatched")

    return {
        "name": name,
        "email": email,
        "password": password,
        "backend_port": backend_port,
        "frontend_port": frontend_port,
        "api_url": api_url,
        "app_url": app_url,
    }


def preflight(args: argparse.Namespace) -> None:
    repo = Path(args.repo).resolve()
    flow_home = Path(os.environ.get("FLOW_HOME", str(Path.home() / ".flow"))).resolve()
    hub_url = _normalize_url(args.hub_url)
    if not hub_url:
        raise Phase11Error("FLOWPAD_HUB_URL is required")
    if args.instance == args.bob_instance:
        raise Phase11Error("INSTANCE and BOB_INSTANCE must be distinct")

    alice = _resolve_instance(
        repo=repo,
        flow_home=flow_home,
        name=args.instance,
        hub_url=hub_url,
        role="Alice",
    )
    bob = _resolve_instance(
        repo=repo,
        flow_home=flow_home,
        name=args.bob_instance,
        hub_url=hub_url,
        role="Bob",
    )
    ports = {
        alice["backend_port"],
        alice["frontend_port"],
        bob["backend_port"],
        bob["frontend_port"],
    }
    if len(ports) != 4:
        raise Phase11Error("Alice/Bob launcher ports are not distinct")

    _request_bytes(f"{hub_url}/api/v1/login/test")
    alice_hub = _hub_login(hub_url, alice["email"], alice.pop("password"))
    bob_hub = _hub_login(hub_url, bob["email"], bob.pop("password"))
    if alice_hub["id"] == bob_hub["id"]:
        raise Phase11Error("Alice and Bob hub identities are not distinct")

    for resolved, hub_identity in ((alice, alice_hub), (bob, bob_hub)):
        _request_bytes(resolved["app_url"])
        resolved["bootstrap_type_count"] = _validate_bootstrap(resolved["api_url"])
        # instance_ctl's cloud login establishes credentials and a connected
        # socket, but it does not run the current-user verification transition.
        # Perform that transition exactly once per cycle-owned instance before
        # requiring the subsequent status response to report verified identity.
        resolved["hub_ws_connect"] = _connect_and_validate_hub_ws(
            resolved["api_url"],
            hub_identity["id"],
        )
        resolved["cloud"] = _validate_cloud_status(
            resolved["api_url"],
            resolved["email"],
            hub_url,
            hub_identity["id"],
        )

    _atomic_json(
        Path(args.output),
        {
            "phase": 11,
            "status": "ready",
            "hub": {
                "url": hub_url,
                "login_test": True,
                "alice_user_id": alice_hub["id"],
                "bob_user_id": bob_hub["id"],
            },
            "instances": {"alice": alice, "bob": bob},
        },
    )


def validate_runtime(args: argparse.Namespace) -> None:
    _request_bytes(args.app_url)
    payload = {
        "status": "ready",
        "bootstrap_type_count": _validate_bootstrap(args.api_url),
        "cloud": _validate_cloud_status(args.api_url, args.email, args.hub_url),
    }
    _atomic_json(Path(args.output), payload)


def clear_for_file(args: argparse.Namespace) -> None:
    clear_data = _response_data(
        _request_json(
            f"{_normalize_url(args.api_url)}/api/v1/graph/compute_node/@local/desktop-db/clear",
            method="POST",
        ),
        "desktop database clear",
    )
    backup_path = clear_data.get("backup_path")
    if not isinstance(backup_path, str) or not backup_path:
        raise Phase11Error("desktop database clear returned no backup path")
    # This GET is intentionally immediate and singular: no poll/retry/sleep.
    type_count = _validate_bootstrap(_normalize_url(args.api_url))
    _atomic_json(
        Path(args.output),
        {
            "status": "cleared",
            "backup_path": backup_path,
            "bootstrap_type_count": type_count,
        },
    )


def _manifest_entries(repo: Path, root: Path) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for source in sorted(root.rglob("*.md.ts")):
        relative_root = source.relative_to(root)
        if "_results" in relative_root.parts:
            continue
        if len(relative_root.parts) < 2:
            raise Phase11Error(f"scenario has no category directory: {relative_root.as_posix()}")
        category = relative_root.parts[0]
        config = root / category / "playwright.config.ts"
        if not config.is_file():
            raise Phase11Error(f"category {category} has .md.ts scenarios but no playwright.config.ts")
        entries.append(
            {
                "file": source.relative_to(repo).as_posix(),
                "category": category,
                "config": config.relative_to(repo).as_posix(),
                "source_sha256": _sha256(source),
                "config_sha256": _sha256(config),
            }
        )
    if not entries:
        raise Phase11Error("Phase 11 manifest contains no .md.ts scenarios")
    return entries


def build_manifest(args: argparse.Namespace) -> None:
    repo = Path(args.repo).resolve()
    root = Path(args.root).resolve()
    entries = _manifest_entries(repo, root)
    _atomic_json(
        Path(args.output),
        {"phase": 11, "expected_files": len(entries), "files": entries},
    )


def _load_manifest(path: Path) -> list[dict[str, str]]:
    payload = _load_json(path, "Phase 11 manifest")
    if not isinstance(payload, dict) or payload.get("phase") != 11:
        raise Phase11Error("Phase 11 manifest has an invalid schema")
    files = payload.get("files")
    if not isinstance(files, list) or not files:
        raise Phase11Error("Phase 11 manifest has no files")
    required = {"file", "category", "config", "source_sha256", "config_sha256"}
    if any(not isinstance(row, dict) or not required.issubset(row) for row in files):
        raise Phase11Error("Phase 11 manifest has an invalid file entry")
    return files


def manifest_lines(args: argparse.Namespace) -> None:
    for row in _load_manifest(Path(args.manifest)):
        values = [str(row[key]) for key in ("category", "file", "config", "source_sha256", "config_sha256")]
        if any("\t" in value or "\n" in value for value in values):
            raise Phase11Error("Phase 11 manifest contains an unsafe path")
        print("\t".join(values))


def category_hash(args: argparse.Namespace) -> None:
    rows = [row for row in _load_manifest(Path(args.manifest)) if row["category"] == args.category]
    if not rows:
        raise Phase11Error(f"unknown Phase 11 category: {args.category}")
    digest = hashlib.sha256(json.dumps(rows, sort_keys=True).encode("utf-8")).hexdigest()
    print(digest)


def validate_reset_payload(payload: Any, *, instance: str, port: int) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise Phase11Error("backend reset JSON is not an object")
    expected = (
        payload.get("instance") == instance,
        payload.get("backend_only") is True,
        payload.get("keychain") == "kept",
        payload.get("relaunched") is True,
        payload.get("port") == port,
        payload.get("ready") is True,
    )
    if not all(expected):
        raise Phase11Error("backend reset JSON failed instance/isolation/readiness validation")
    return payload


def record_reset(args: argparse.Namespace) -> None:
    reset = validate_reset_payload(
        _load_json(Path(args.input), "backend reset output"),
        instance=args.instance,
        port=args.port,
    )
    _atomic_json(
        Path(args.output),
        {
            "phase": 11,
            "category": args.category,
            "category_hash": args.category_hash,
            "reset": reset,
        },
    )


def validate_reset_marker(args: argparse.Namespace) -> None:
    marker = _load_json(Path(args.input), "category reset marker")
    if not isinstance(marker, dict):
        raise Phase11Error("category reset marker is not an object")
    if marker.get("phase") != 11 or marker.get("category") != args.category:
        raise Phase11Error("category reset marker has the wrong identity")
    if marker.get("category_hash") != args.category_hash:
        raise Phase11Error("category reset marker is stale")
    validate_reset_payload(marker.get("reset"), instance=args.instance, port=args.port)


def write_exit(args: argparse.Namespace) -> None:
    _atomic_json(
        Path(args.output),
        {
            "phase": 11,
            "file": args.file,
            "source_sha256": args.source_sha256,
            "config_sha256": args.config_sha256,
            "exit_code": args.exit_code,
        },
    )


def _load_exit(
    path: Path,
    *,
    expected_file: str,
    source_sha256: str,
    config_sha256: str,
) -> int:
    payload = _load_json(path, "Playwright exit capture")
    if not isinstance(payload, dict) or payload.get("phase") != 11:
        raise Phase11Error("Playwright exit capture has an invalid schema")
    expected = (
        payload.get("file") == expected_file,
        payload.get("source_sha256") == source_sha256,
        payload.get("config_sha256") == config_sha256,
        isinstance(payload.get("exit_code"), int),
        not isinstance(payload.get("exit_code"), bool),
        0 <= payload.get("exit_code", -1) <= 255,
    )
    if not all(expected):
        raise Phase11Error("Playwright exit capture is stale or mismatched")
    return int(payload["exit_code"])


def _iter_specs(suite: dict[str, Any], parents: tuple[str, ...] = ()) -> Iterator[tuple[tuple[str, ...], dict[str, Any], str | None]]:
    title = suite.get("title")
    path = parents + ((title,) if isinstance(title, str) and title else ())
    source = suite.get("file") if isinstance(suite.get("file"), str) else None
    specs = suite.get("specs", [])
    if not isinstance(specs, list):
        raise Phase11Error("Playwright JSON suite.specs is not a list")
    for spec in specs:
        if not isinstance(spec, dict):
            raise Phase11Error("Playwright JSON contains a non-object spec")
        yield path, spec, spec.get("file") if isinstance(spec.get("file"), str) else source
    children = suite.get("suites", [])
    if not isinstance(children, list):
        raise Phase11Error("Playwright JSON suite.suites is not a list")
    for child in children:
        if not isinstance(child, dict):
            raise Phase11Error("Playwright JSON contains a non-object child suite")
        yield from _iter_specs(child, path)


def _source_matches(repo: Path, expected_file: str, reported: str | None) -> bool:
    if not reported:
        return False
    expected = (repo / expected_file).resolve()
    value = Path(reported)
    # With a category-local Playwright ``testDir``, the JSON reporter emits a
    # basename (for example ``doc_chat_per_type.md.ts``).  The exit capture is
    # already bound to the manifest's source+config hashes, so matching that
    # basename is unambiguous within the required category config.
    if len(value.parts) == 1:
        return value.name == expected.name
    candidates = [value.resolve()] if value.is_absolute() else [(repo / value).resolve(), (repo / "ui" / value).resolve()]
    return expected in candidates


def _permitted_skip(annotations: Any) -> tuple[str | None, str | None]:
    if not isinstance(annotations, list):
        return None, None
    for annotation in annotations:
        if not isinstance(annotation, dict) or annotation.get("type") != "skip":
            continue
        description = annotation.get("description")
        if not isinstance(description, str) or not description.strip():
            continue
        normalized = description.strip().lower()
        for reason, prefixes in ALLOWED_SKIP_PREFIXES.items():
            for prefix in prefixes:
                if normalized.startswith(prefix):
                    detail = normalized[len(prefix) :].strip(" :-—")
                    if len(detail) >= 8:
                        return reason, description.strip()
    return None, None


def assess_report(
    report: dict[str, Any],
    *,
    repo: Path,
    expected_file: str,
    exit_code: int,
) -> dict[str, Any]:
    """Return a file verdict.  Raises only when no machine verdict exists."""
    if not isinstance(report, dict):
        raise Phase11Error("Playwright report is not an object")
    stats = report.get("stats")
    if not isinstance(stats, dict):
        raise Phase11Error("Playwright report has no stats object")
    for field in ("expected", "skipped", "unexpected", "flaky"):
        value = stats.get(field)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise Phase11Error(f"Playwright report stats.{field} is invalid")
    suites = report.get("suites")
    if not isinstance(suites, list):
        raise Phase11Error("Playwright report suites is not a list")

    tests: list[dict[str, Any]] = []
    file_issues: list[str] = []
    if exit_code != 0:
        file_issues.append(f"playwright_exit_{exit_code}")
    if stats["unexpected"] > 0:
        file_issues.append("stats_unexpected")
    if stats["flaky"] > 0:
        file_issues.append("stats_flaky")
    errors = report.get("errors", [])
    if not isinstance(errors, list):
        raise Phase11Error("Playwright report errors is not a list")
    if errors:
        file_issues.append("top_level_errors")

    for suite in suites:
        if not isinstance(suite, dict):
            raise Phase11Error("Playwright report contains a non-object suite")
        for parents, spec, source in _iter_specs(suite):
            if not _source_matches(repo, expected_file, source):
                file_issues.append("reported_source_mismatch")
            spec_title = spec.get("title")
            if not isinstance(spec_title, str) or not spec_title:
                raise Phase11Error("Playwright report spec has no title")
            raw_tests = spec.get("tests")
            if not isinstance(raw_tests, list):
                raise Phase11Error("Playwright report spec.tests is not a list")
            chromium = [test for test in raw_tests if isinstance(test, dict) and test.get("projectName") == "chromium"]
            for test in chromium:
                results = test.get("results")
                if not isinstance(results, list) or not results:
                    raise Phase11Error("Chromium test has no final Playwright result")
                if any(not isinstance(result, dict) for result in results):
                    raise Phase11Error("Chromium test contains a non-object result")
                final = results[-1]
                final_status = final.get("status")
                test_status = test.get("status")
                test_issues: list[str] = []
                durations: list[float] = []
                for attempt, result in enumerate(results):
                    status = result.get("status")
                    duration = result.get("duration")
                    if not isinstance(duration, (int, float)) or isinstance(duration, bool) or duration < 0:
                        test_issues.append(f"attempt_{attempt}_invalid_duration")
                    else:
                        durations.append(float(duration))
                        if duration > MAX_TEST_DURATION_MS:
                            test_issues.append(f"attempt_{attempt}_duration_over_60000ms")
                    if status in BAD_RESULT_STATUSES:
                        test_issues.append(f"attempt_{attempt}_{status}")
                    elif status not in ALLOWED_RESULT_STATUSES:
                        test_issues.append(f"attempt_{attempt}_unknown_status")

                skip_reason = None
                skip_description = None
                skipped = test_status == "skipped" or final_status == "skipped"
                if skipped:
                    skip_reason, skip_description = _permitted_skip(test.get("annotations"))
                    if not skip_reason:
                        test_issues.append("disallowed_or_undocumented_skip")
                elif test_status != "expected" or final_status != "passed":
                    test_issues.append("nonexpected_test_status")
                if len(results) > 1:
                    test_issues.append("multiple_attempts_flaky")

                title_parts = [part for part in parents if part]
                title_parts.append(spec_title)
                tests.append(
                    {
                        "file": expected_file,
                        "title": " > ".join(title_parts),
                        "project": "chromium",
                        "test_status": test_status,
                        "result_status": final_status,
                        "duration_ms": durations[-1] if durations else None,
                        "skip_reason": skip_reason,
                        "skip_description": skip_description,
                        "verdict": "passed" if not test_issues else "blocked",
                        "issues": sorted(set(test_issues)),
                    }
                )

    if not tests:
        raise Phase11Error("Playwright report contains no Chromium test verdicts")
    if stats["expected"] + stats["skipped"] + stats["unexpected"] + stats["flaky"] != len(tests):
        file_issues.append("stats_test_count_mismatch")
    if any(test["issues"] for test in tests):
        file_issues.append("test_gate_failed")
    file_issues = sorted(set(file_issues))
    return {
        "file": expected_file,
        "exit_code": exit_code,
        "verdict": "passed" if not file_issues else "blocked",
        "issues": file_issues,
        "stats": {
            key: stats[key]
            for key in ("expected", "skipped", "unexpected", "flaky")
        },
        "test_count": len(tests),
        "tests": tests,
    }


def _assessment_from_paths(args: argparse.Namespace) -> dict[str, Any]:
    exit_code = _load_exit(
        Path(args.exit),
        expected_file=args.file,
        source_sha256=args.source_sha256,
        config_sha256=args.config_sha256,
    )
    report = _load_json(Path(args.report), "Playwright JSON report")
    return assess_report(
        report,
        repo=Path(args.repo).resolve(),
        expected_file=args.file,
        exit_code=exit_code,
    )


def assess(args: argparse.Namespace) -> None:
    assessment = _assessment_from_paths(args)
    if args.output:
        _atomic_json(Path(args.output), assessment)


def _artifact_paths(run_dir: Path, file_name: str) -> tuple[Path, Path]:
    relative = Path(file_name)
    stem = relative.name[: -len(".md.ts")]
    directory = run_dir / "phase11-files" / relative.parent.relative_to("ui/tests/manual_regression") / stem
    return directory / "report.json", directory / "exit.json"


def aggregate(args: argparse.Namespace) -> None:
    repo = Path(args.repo).resolve()
    run_dir = Path(args.run_dir).resolve()
    rows = _load_manifest(Path(args.manifest))
    current = _manifest_entries(repo, repo / "ui/tests/manual_regression")
    infra: list[str] = []
    if rows != current:
        infra.append("manifest_changed_during_sweep")
    if args.infra:
        infra.append(args.infra)

    files: list[dict[str, Any]] = []
    tests: list[dict[str, Any]] = []
    missing = 0
    no_verdict = 0
    for row in rows:
        report_path, exit_path = _artifact_paths(run_dir, row["file"])
        namespace = argparse.Namespace(
            repo=str(repo),
            file=row["file"],
            source_sha256=row["source_sha256"],
            config_sha256=row["config_sha256"],
            report=str(report_path),
            exit=str(exit_path),
        )
        if not report_path.exists() or not exit_path.exists():
            missing += 1
            files.append(
                {
                    "file": row["file"],
                    "category": row["category"],
                    "verdict": "missing",
                    "issues": ["missing_machine_verdict"],
                    "test_count": 0,
                }
            )
            continue
        try:
            item = _assessment_from_paths(namespace)
        except Phase11Error:
            no_verdict += 1
            files.append(
                {
                    "file": row["file"],
                    "category": row["category"],
                    "verdict": "infra",
                    "issues": ["unparseable_or_incomplete_machine_verdict"],
                    "test_count": 0,
                }
            )
            continue
        item["category"] = row["category"]
        tests.extend(item.pop("tests"))
        files.append(item)

    totals = {
        "files_passed": sum(item["verdict"] == "passed" for item in files),
        "files_blocked": sum(item["verdict"] == "blocked" for item in files),
        "files_missing": missing,
        "files_infra": no_verdict,
        "tests_total": len(tests),
        "tests_passed": sum(test["verdict"] == "passed" and not test["skip_reason"] for test in tests),
        "tests_blocked": sum(test["verdict"] == "blocked" for test in tests),
        "tests_skipped_permitted": sum(bool(test["skip_reason"]) and test["verdict"] == "passed" for test in tests),
        "tests_skipped_disallowed": sum("disallowed_or_undocumented_skip" in test["issues"] for test in tests),
        "tests_over_60000ms": sum(any("duration_over_60000ms" in issue for issue in test["issues"]) for test in tests),
    }
    reported_files = len(rows) - missing - no_verdict
    gate_passed = (
        not infra
        and reported_files == len(rows)
        and totals["files_blocked"] == 0
        and totals["files_missing"] == 0
        and totals["files_infra"] == 0
    )
    summary = {
        "phase": 11,
        "expected_files": len(rows),
        "reported_files": reported_files,
        "gate": "passed" if gate_passed else "blocked",
        "infra": sorted(set(infra)),
        "totals": totals,
        "files": files,
        "tests": tests,
    }
    _atomic_json(Path(args.output), summary)


def get_value(args: argparse.Namespace) -> None:
    value: Any = _load_json(Path(args.input), "JSON input")
    for part in args.key.split("."):
        if not isinstance(value, dict) or part not in value:
            raise Phase11Error(f"JSON input has no key {args.key}")
        value = value[part]
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        raise Phase11Error(f"JSON key {args.key} is not scalar")
    print(value)


def generated_env_value(args: argparse.Namespace) -> None:
    allowed = {
        "FLOWPAD_CLOUD_USER_EMAIL",
        "FLOWPAD_CLOUD_USER_PASSWORD",
        "LOCAL_SERVER_PORT",
        "VITE_PORT",
    }
    if args.key not in allowed:
        raise Phase11Error("requested generated env key is not allow-listed")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", args.instance):
        raise Phase11Error("unsafe instance name")
    env = _parse_dotenv(Path(args.repo).resolve() / f".env.{args.instance}.local")
    print(_require_env_value(env, args.key, args.instance))


def validate_run_dir(args: argparse.Namespace) -> None:
    root = Path(args.results_root).resolve()
    candidate = Path(args.run_dir).resolve()
    if candidate == root or root not in candidate.parents:
        raise Phase11Error("RD must be a child of the manual-regression _results directory")
    print(candidate)


def _add_assessment_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repo", required=True)
    parser.add_argument("--file", required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--exit", required=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    cmd = sub.add_parser("preflight")
    cmd.add_argument("--repo", required=True)
    cmd.add_argument("--instance", required=True)
    cmd.add_argument("--bob-instance", required=True)
    cmd.add_argument("--hub-url", required=True)
    cmd.add_argument("--output", required=True)
    cmd.set_defaults(func=preflight)

    cmd = sub.add_parser("runtime")
    cmd.add_argument("--api-url", required=True)
    cmd.add_argument("--app-url", required=True)
    cmd.add_argument("--email", required=True)
    cmd.add_argument("--hub-url", required=True)
    cmd.add_argument("--output", required=True)
    cmd.set_defaults(func=validate_runtime)

    cmd = sub.add_parser("clear")
    cmd.add_argument("--api-url", required=True)
    cmd.add_argument("--output", required=True)
    cmd.set_defaults(func=clear_for_file)

    cmd = sub.add_parser("manifest")
    cmd.add_argument("--repo", required=True)
    cmd.add_argument("--root", required=True)
    cmd.add_argument("--output", required=True)
    cmd.set_defaults(func=build_manifest)

    cmd = sub.add_parser("manifest-lines")
    cmd.add_argument("--manifest", required=True)
    cmd.set_defaults(func=manifest_lines)

    cmd = sub.add_parser("category-hash")
    cmd.add_argument("--manifest", required=True)
    cmd.add_argument("--category", required=True)
    cmd.set_defaults(func=category_hash)

    cmd = sub.add_parser("record-reset")
    cmd.add_argument("--input", required=True)
    cmd.add_argument("--output", required=True)
    cmd.add_argument("--instance", required=True)
    cmd.add_argument("--port", required=True, type=int)
    cmd.add_argument("--category", required=True)
    cmd.add_argument("--category-hash", required=True)
    cmd.set_defaults(func=record_reset)

    cmd = sub.add_parser("validate-reset")
    cmd.add_argument("--input", required=True)
    cmd.add_argument("--instance", required=True)
    cmd.add_argument("--port", required=True, type=int)
    cmd.add_argument("--category", required=True)
    cmd.add_argument("--category-hash", required=True)
    cmd.set_defaults(func=validate_reset_marker)

    cmd = sub.add_parser("write-exit")
    cmd.add_argument("--output", required=True)
    cmd.add_argument("--file", required=True)
    cmd.add_argument("--source-sha256", required=True)
    cmd.add_argument("--config-sha256", required=True)
    cmd.add_argument("--exit-code", required=True, type=int)
    cmd.set_defaults(func=write_exit)

    cmd = sub.add_parser("assess")
    _add_assessment_args(cmd)
    cmd.add_argument("--output")
    cmd.set_defaults(func=assess)

    cmd = sub.add_parser("aggregate")
    cmd.add_argument("--repo", required=True)
    cmd.add_argument("--run-dir", required=True)
    cmd.add_argument("--manifest", required=True)
    cmd.add_argument("--output", required=True)
    cmd.add_argument("--infra")
    cmd.set_defaults(func=aggregate)

    cmd = sub.add_parser("get")
    cmd.add_argument("--input", required=True)
    cmd.add_argument("--key", required=True)
    cmd.set_defaults(func=get_value)

    cmd = sub.add_parser("env-value")
    cmd.add_argument("--repo", required=True)
    cmd.add_argument("--instance", required=True)
    cmd.add_argument("--key", required=True)
    cmd.set_defaults(func=generated_env_value)

    cmd = sub.add_parser("validate-run-dir")
    cmd.add_argument("--results-root", required=True)
    cmd.add_argument("--run-dir", required=True)
    cmd.set_defaults(func=validate_run_dir)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except Phase11Error as exc:
        print(f"phase11: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
