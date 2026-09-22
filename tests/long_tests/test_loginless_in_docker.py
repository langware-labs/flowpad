"""A machine that never logged in runs an agentic process, funded by a PUBLIC hub endpoint.

THE acceptance for ``flow llm user use <endpoint-id>``: a clean container holding nothing of ours
but the wheel -- no hub key, no provider key, no ``FLOWPAD_HUB_URL``, no sod key -- runs exactly
two commands (``tests/loginless_e2e/run.sh``) and an agent answers:

    flow llm user use <public-endpoint-id> --hub <hub>
    python agentic_process_snippet.py        # docs/snippets/llm-endpoints.md

Needs a hub YOU started for this, running code that knows ``public`` endpoints, plus docker and a
real OpenRouter key (the endpoint still spends one -- only the BOX is credential-free):

    LOGINLESS_HUB_URL=http://localhost:8094 OPENROUTER_API_KEY=... \\
        uv run pytest tests/long_tests/test_loginless_in_docker.py
"""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import requests

REPO = Path(__file__).resolve().parents[2]
HUB = os.environ.get("LOGINLESS_HUB_URL", "").rstrip("/")
IMAGE = "flowpad-loginless:test"
pytestmark = [pytest.mark.timeout(900)]  # image build + a fresh container's first model turn


def _openrouter_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key and (REPO / ".env.local").is_file():
        match = re.search(r"^OPENROUTER_API_KEY=(.+)$", (REPO / ".env.local").read_text(), re.M)
        key = match.group(1).strip().strip("'\"") if match else ""
    return key


@pytest.fixture(scope="module")
def rig() -> dict:
    if not HUB:
        pytest.skip("LOGINLESS_HUB_URL is not set (a hub started for this test)")
    if not re.match(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$", HUB):
        pytest.skip("refusing a non-local hub: this test creates an owner and a public budget on it")
    if shutil.which("docker") is None or not _openrouter_key():
        pytest.skip("needs docker and an OpenRouter key")
    return {**os.environ, "HUB": HUB, "OPENROUTER_API_KEY": _openrouter_key()}


def _owner() -> dict:
    """The auth header of the hub account ``make_public_endpoint.py`` created the budget with."""
    token = requests.post(
        f"{HUB}/api/v1/login/local",
        json={"email": "loginless-owner@local.test", "password": "owner-pw-1234"},
    ).json()["data"]["token"]
    return {"Authorization": f"Bearer {token}"}


def _run(rig: dict, **extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(REPO / "tests/loginless_e2e/run.sh")], env={**rig, **extra}, capture_output=True, text=True, check=False
    )


def test_two_commands_on_a_machine_that_never_logged_in(rig):
    done = _run(rig)
    assert done.returncode == 0, done.stdout[-2000:] + done.stderr[-2000:]
    assert done.stdout.strip().splitlines()[-1].strip().lower() == "pong", done.stdout[-2000:]
    rig["ENDPOINT_ID"] = re.search(r"public endpoint: (\S+)", done.stderr).group(1)

    # It was the PUBLIC endpoint that paid, booked against the endpoint with no principal at all.
    usage = requests.get(f"{HUB}/api/v1/graph/llm_endpoint/{rig['ENDPOINT_ID']}/usage", headers=_owner()).json()[
        "data"
    ]["totals"]
    assert usage["requests"] > 0 and usage["cost_micro_usd"] > 0, usage


def test_the_box_held_no_hub_key(rig):
    """Loginless, not a leaked login: after command 1 the box still has nothing to sign with."""
    if "ENDPOINT_ID" not in rig:
        pytest.skip("the bind above did not run")
    hub_in_container = HUB.replace("localhost", "host.docker.internal").replace("127.0.0.1", "host.docker.internal")
    done = subprocess.run(
        [
            "docker", "run", "--rm", "--add-host=host.docker.internal:host-gateway", IMAGE, "sh", "-c",
            f"flow llm user use {rig['ENDPOINT_ID']} --hub {hub_in_container} >/dev/null && "
            "python -c 'from flow_sdk.cli.auth.hub_login import resolve_hub_api_key as r; print(r())'",
        ],
        capture_output=True, text=True, check=False,
    )  # fmt: skip
    assert done.returncode == 0, done.stderr[-2000:]
    assert done.stdout.strip().splitlines()[-1] == "None"


def test_a_private_endpoint_is_refused_at_the_first_command(rig):
    private = requests.post(f"{HUB}/api/v1/graph/llm_endpoint", headers=_owner(), json={"name": "private"}).json()[
        "data"
    ]["id"]

    done = _run(rig, ENDPOINT_ID=private, SKIP_BUILD="1")
    assert done.returncode == 6, done.stdout[-1000:] + done.stderr[-1000:]
    assert "NOT_PUBLIC" in done.stdout + done.stderr


def test_every_harness_answers_on_cheap_open_models(rig):
    """The same single bind funds all four harnesses, on models none of them ships with.

    ``worker_matrix.py`` is claude/codex/copilot/opencode x Kimi, GLM and Qwen. The endpoint is the
    one ``make_public_endpoint.py`` makes, which routes around Novita: that host answered the Qwen
    slug with an EMPTY completion for about a third of requests, so without ``providers_ignore``
    this test fails intermittently on whichever harness draws it.
    """
    if "ENDPOINT_ID" not in rig:
        pytest.skip("the bind above did not run")
    done = _run(rig, SKIP_BUILD="1", SCRIPT="worker_matrix.py")
    cells = [line for line in done.stdout.splitlines() if line.startswith(("PASS", "FAIL", "SKIP"))]
    assert done.returncode == 0 and len(cells) == 12, "\n".join(cells) + done.stderr[-1500:]
    assert all(line.startswith("PASS") for line in cells), "\n".join(cells)
