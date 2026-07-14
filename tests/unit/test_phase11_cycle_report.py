from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO = Path(__file__).resolve().parents[2]
HELPER_PATH = REPO / "scripts" / "phase11_cycle_report.py"
RUNNER_PATH = REPO / "scripts" / "run_phase11_cycle.sh"

_SPEC = importlib.util.spec_from_file_location("phase11_cycle_report", HELPER_PATH)
assert _SPEC and _SPEC.loader
phase11 = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(phase11)


def _report(
    *,
    test_status: str = "expected",
    result_status: str = "passed",
    duration: int = 10,
    annotations: list[dict] | None = None,
    unexpected: int = 0,
    flaky: int = 0,
) -> dict:
    skipped = int(test_status == "skipped")
    expected = int(test_status == "expected")
    return {
        "suites": [
            {
                "title": "outer",
                "suites": [
                    {
                        "title": "inner",
                        "specs": [
                            {
                                "title": "scenario",
                                "file": "sample.md.ts",
                                "tests": [
                                    {
                                        "projectName": "chromium",
                                        "status": test_status,
                                        "annotations": annotations or [],
                                        "results": [
                                            {"status": result_status, "duration": duration}
                                        ],
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        ],
        "errors": [],
        "stats": {
            "expected": expected,
            "skipped": skipped,
            "unexpected": unexpected,
            "flaky": flaky,
        },
    }


def _assess(report: dict, *, exit_code: int = 0) -> dict:
    return phase11.assess_report(
        report,
        repo=REPO,
        expected_file="ui/tests/manual_regression/example/sample.md.ts",
        exit_code=exit_code,
    )


def test_recursive_report_allows_only_documented_environment_skip() -> None:
    report = _report(
        test_status="skipped",
        result_status="skipped",
        annotations=[
            {
                "type": "skip",
                "description": "live-claude: requires the model to actively think and respond",
            }
        ],
    )

    result = _assess(report)

    assert result["verdict"] == "passed"
    assert result["tests"][0]["skip_reason"] == "live-claude"


@pytest.mark.parametrize(
    "description",
    [
        "harness: needs another browser",
        "removed: old product surface",
        "wip-feature: not implemented",
        "",
    ],
)
def test_disallowed_or_empty_skip_blocks(description: str) -> None:
    report = _report(
        test_status="skipped",
        result_status="skipped",
        annotations=[{"type": "skip", "description": description}],
    )

    result = _assess(report)

    assert result["verdict"] == "blocked"
    assert "disallowed_or_undocumented_skip" in result["tests"][0]["issues"]


def test_duration_over_one_minute_blocks_even_when_playwright_passed() -> None:
    result = _assess(_report(duration=60_001))

    assert result["verdict"] == "blocked"
    assert "attempt_0_duration_over_60000ms" in result["tests"][0]["issues"]


def test_nonzero_exit_is_a_real_blocked_verdict_not_missing_infra() -> None:
    result = _assess(_report(), exit_code=1)

    assert result["verdict"] == "blocked"
    assert result["issues"] == ["playwright_exit_1"]
    assert result["test_count"] == 1


def test_report_without_chromium_results_has_no_machine_verdict() -> None:
    report = _report()
    report["suites"][0]["suites"][0]["specs"][0]["tests"] = []

    with pytest.raises(phase11.Phase11Error, match="no Chromium test verdicts"):
        _assess(report)


def test_ws_connect_is_singular_post_and_requires_verified_identity(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []

    def fake_request(url: str, *, method: str = "GET", body=None) -> dict:
        assert body is None
        calls.append((url, method))
        return {
            "status": "SUCCESS",
            "data": {
                "hub_ws_connected": True,
                "hub_ws_verified": True,
                "hub_ws_status": "verified",
                "verification": {
                    "verified": True,
                    "local_user_id": "hub-user-1",
                    "hub_user_id": "hub-user-1",
                },
            },
        }

    monkeypatch.setattr(phase11, "_request_json", fake_request)

    result = phase11._connect_and_validate_hub_ws("http://localhost:6034", "hub-user-1")

    assert calls == [("http://localhost:6034/api/v1/cloud/ws/connect", "POST")]
    assert result["hub_ws_verified"] is True
    assert result["user_id"] == "hub-user-1"


def test_preflight_connects_then_reads_status_for_each_instance(monkeypatch, tmp_path) -> None:
    events: list[tuple[str, str]] = []

    def resolved(*, name: str, role: str, **_kwargs) -> dict:
        suffix = "a" if role == "Alice" else "b"
        return {
            "name": name,
            "email": f"{suffix}@local.test",
            "password": f"{suffix}-pw",
            "backend_port": 6034 if suffix == "a" else 6035,
            "frontend_port": 5034 if suffix == "a" else 5035,
            "api_url": f"http://localhost:603{'4' if suffix == 'a' else '5'}",
            "app_url": f"http://localhost:503{'4' if suffix == 'a' else '5'}",
        }

    monkeypatch.setattr(phase11, "_resolve_instance", resolved)
    monkeypatch.setattr(phase11, "_request_bytes", lambda *_args, **_kwargs: b"ok")
    monkeypatch.setattr(
        phase11,
        "_hub_login",
        lambda _hub, email, _pw: {"id": f"id-{email[0]}", "email": email},
    )
    monkeypatch.setattr(phase11, "_validate_bootstrap", lambda _api: 10)

    def connect(api: str, user_id: str) -> dict:
        events.append(("connect", api))
        return {"hub_ws_verified": True, "user_id": user_id}

    def status(api: str, _email: str, _hub: str, expected_user_id: str) -> dict:
        assert events[-1] == ("connect", api)
        events.append(("status", api))
        return {"logged_in": True, "user_id": expected_user_id}

    monkeypatch.setattr(phase11, "_connect_and_validate_hub_ws", connect)
    monkeypatch.setattr(phase11, "_validate_cloud_status", status)

    phase11.preflight(
        SimpleNamespace(
            repo=str(REPO),
            instance="qa-a-34",
            bob_instance="qa-b-35",
            hub_url="http://localhost:8193",
            output=str(tmp_path / "preflight.json"),
        )
    )

    assert events == [
        ("connect", "http://localhost:6034"),
        ("status", "http://localhost:6034"),
        ("connect", "http://localhost:6035"),
        ("status", "http://localhost:6035"),
    ]


def test_runner_source_policy_has_no_dotenv_execution_or_new_wait_budget() -> None:
    executable_lines = [
        line.strip()
        for line in RUNNER_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    executable = "\n".join(executable_lines)

    assert not re.search(r"(?:^|\s)(?:source|\.)\s+[^\n]*\.env", executable)
    assert not re.search(r"(?:^|\s)sleep\s", executable)
    assert not re.search(r"--(?:timeout|retries)(?:=|\s)", executable)
    assert "--backend-only --keep-keychain --json" in executable
    assert "--workers=1" in executable
    assert "PLAYWRIGHT_JSON_OUTPUT_NAME" in executable
    assert "QA_BOB_HUB_ID" in executable
