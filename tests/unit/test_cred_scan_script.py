"""The cred-scan inventory script against a small, fully known project.

The fixture exercises one instance of each evidence source the script covers
mechanically, and plants a sentinel VALUE in every place a value lives so the
one rule that matters most — names and places, never values — is checked on the
whole output rather than per field.
"""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest

SKILL_DIR = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/cred-scan"
)
SENTINEL = "Sentinel9Value7"


def _load():
    spec = importlib.util.spec_from_file_location("cred_scan", SKILL_DIR / "scripts/cred_scan.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cred_scan = _load()


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    _write(tmp_path, "app/main.py", "\n".join([
        "import os",
        'DB = os.environ["DATABASE_URL"]',
        'LEVEL = os.getenv("LOG_LEVEL", "info")',
        'HOOK = os.environ.get("SLACK_WEBHOOK_URL")',
        f'client_key = "sk-proj-{SENTINEL}abcdefghijklmnopqrstuvwxyz0123"',
    ]))
    _write(tmp_path, "app/settings.py", "\n".join([
        "from pydantic_settings import BaseSettings",
        "class Settings(BaseSettings):",
        "    stripe_api_key: str",
        "    request_timeout: int = 30",
    ]))
    _write(tmp_path, "web/env.ts", "\n".join([
        "const key = process.env.RESEND_API_KEY!;",
        "const port = process.env.PORT ?? '3000';",
        "if (process.env.FEATURE_X !== 'on') {}",
    ]))
    _write(tmp_path, ".env.example", "\n".join([
        "# Postgres connection string",
        "DATABASE_URL=",
        "# SENTRY_DSN=",
    ]))
    _write(tmp_path, ".env.local", f"DATABASE_URL=postgres://u:{SENTINEL}@db.internal/app\nPRIVATE_ONLY={SENTINEL}\n")
    _write(tmp_path, "docker-compose.yml", "\n".join([
        "services:",
        "  api:",
        "    environment:",
        "      - REDIS_URL=${REDIS_URL:?set redis}",
        "      - WORKERS=${WORKERS:-4}",
    ]))
    _write(tmp_path, ".github/workflows/test.yml", "\n".join([
        "jobs:",
        "  test:",
        "    env:",
        "      E2E_TOKEN: ${{ secrets.E2E_TOKEN }}",
        "  deploy:",
        "    steps:",
        "      - run: ./ship ${{ secrets.FLY_API_TOKEN }}",
    ]))
    _write(tmp_path, "tests/test_live.py", "\n".join([
        "import os, pytest",
        'pytestmark = pytest.mark.skipif(not os.getenv("LIVE_API_KEY"), reason="live")',
    ]))
    _write(tmp_path, "infra/main.tf", "\n".join([
        'variable "db_password" {',
        "  type      = string",
        "  sensitive = true",
        "}",
        'variable "region" {',
        '  default = "us-east-1"',
        "}",
    ]))
    _write(tmp_path, "requirements.txt", "openai>=1.0\nrequests\n")
    _write(tmp_path, "node_modules/lib/index.js", "process.env.VENDORED_KEY")
    return tmp_path


@pytest.fixture
def inventory(project: Path) -> dict:
    return cred_scan.scan(project).to_json()


def _signals(inventory: dict, name: str) -> set[str]:
    rows = [v for v in inventory["vars"] if v["name"] == name]
    assert rows, f"{name} was not inventoried"
    return set(rows[0]["signals"])


def test_no_value_ever_reaches_the_output(inventory: dict):
    assert SENTINEL not in json.dumps(inventory)


@pytest.mark.parametrize(
    ("name", "signal"),
    [
        ("DATABASE_URL", "hard"),
        ("DATABASE_URL", "template"),
        ("DATABASE_URL", "present"),
        ("LOG_LEVEL", "default"),
        ("SLACK_WEBHOOK_URL", "read"),
        ("STRIPE_API_KEY", "schema"),
        ("REQUEST_TIMEOUT", "schema-default"),
        ("RESEND_API_KEY", "hard"),
        ("PORT", "default"),
        ("FEATURE_X", "read"),
        ("SENTRY_DSN", "optional"),
        ("REDIS_URL", "infra-hard"),
        ("WORKERS", "infra-default"),
        ("E2E_TOKEN", "ci-test"),
        ("FLY_API_TOKEN", "ci-deploy"),
        ("LIVE_API_KEY", "test-skip"),
        ("TF_VAR_db_password", "infra-hard"),
        ("TF_VAR_region", "infra-default"),
        ("OPENAI_API_KEY", "sdk"),
    ],
)
def test_each_source_yields_its_signal(inventory: dict, name: str, signal: str):
    assert signal in _signals(inventory, name)


def test_evidence_points_at_the_line(inventory: dict):
    row = next(v for v in inventory["vars"] if v["name"] == "DATABASE_URL")
    assert {"file": "app/main.py", "line": 2, "source": "code", "signal": "hard"} in row["evidence"]
    template = next(e for e in row["evidence"] if e["source"] == "env-template")
    assert template["note"] == "Postgres connection string"


def test_vendored_and_ambient_names_are_not_the_projects(inventory: dict):
    names = {v["name"] for v in inventory["vars"]}
    assert "VENDORED_KEY" not in names


def test_a_hardcoded_key_is_an_alert_by_place_and_kind(inventory: dict):
    assert inventory["alerts"] == [{"file": "app/main.py", "line": 5, "kind": "openai-key"}]


def test_obvious_fakes_and_local_defaults_are_not_alerts(tmp_path: Path):
    _write(tmp_path, "t.py", "\n".join([
        'k = "sk-definitely-not-a-real-key-for-tests-000000"',
        'u = "postgresql://postgres:postgres@127.0.0.1:5432/db"',
        "x = 'sk-SK-C5VTKIMK-BYcr7vwH'",
    ]))
    assert cred_scan.scan(tmp_path).to_json()["alerts"] == []


def test_the_sdk_page_and_the_script_table_agree():
    page = (SKILL_DIR / "references/sdk-implicit.md").read_text(encoding="utf-8")
    documented = set(re.findall(r"^\| ([a-z0-9]+) \|", page, re.M)) - {"service"}
    in_script = {service for service, _, _ in cred_scan.SDK_IMPLICIT.values()}
    assert documented == in_script
