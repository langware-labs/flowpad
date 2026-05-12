"""Stress-matrix harness fixtures.

Pre-flight responsibilities:
  1. Skip the whole module if DEEP_TESTING is off (matches long_tests convention).
  2. Skip if docker is unavailable on the host.
  3. Validate ANTHROPIC_API_KEY against api.anthropic.com once per session;
     abort the whole matrix run with a loud message on invalid/rate-limited.
  4. Build the harness Docker image once per session.

Per ``feedback_no_mocks_in_integration_tests`` and the user's "real claude only"
choice, the image installs the actual ``@anthropic-ai/claude-code`` CLI and
cells run real API calls. The pre-flight check is the *one* time we hit the
API outside a cell — it ensures we don't burn a 30-cell run discovering the
key was bad.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping stress matrix when DEEP_TESTING is disabled",
)


REPO_ROOT = Path(__file__).resolve().parents[3]
HARNESS_DIR = Path(__file__).parent
DOCKERFILE_PATH = HARNESS_DIR / "Dockerfile"
RUNNER_SCRIPT = HARNESS_DIR / "runner_entrypoint.py"
VICTIMIZE_SCRIPT = HARNESS_DIR / "victimize.sh"
IMAGE_TAG = "flowpad-stress-matrix:latest"

ANTHROPIC_VALIDATE_URL = "https://api.anthropic.com/v1/models"
ANTHROPIC_VERSION = "2023-06-01"
PREFLIGHT_TIMEOUT_SECONDS = 5.0


def _abort(reason: str) -> None:
    """Stop the whole pytest session loudly. Used for environment problems
    that no individual cell can recover from."""
    pytest.exit(reason, returncode=2)


@pytest.fixture(scope="session")
def docker_available() -> str:
    """Path to the docker binary; aborts if docker isn't usable."""
    docker_bin = shutil.which("docker")
    if not docker_bin:
        pytest.skip("docker not installed on host — stress matrix unavailable")
    try:
        result = subprocess.run(
            [docker_bin, "info"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        pytest.skip("docker info timed out — daemon not responding")
    if result.returncode != 0:
        pytest.skip(f"docker daemon not reachable: {result.stderr.strip()[:200]}")
    return docker_bin


@pytest.fixture(scope="session")
def valid_api_key() -> str:
    """Validate ANTHROPIC_API_KEY against api.anthropic.com once per session.

    Returns the key on success. Aborts the whole session on invalid / rate-
    limited / network failure — these are environment problems, not cell
    failures, so cells should never run under those conditions.
    """
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        _abort("INVALID_API_KEY: ANTHROPIC_API_KEY is unset; set it before running stress matrix")

    req = urllib.request.Request(
        ANTHROPIC_VALIDATE_URL,
        headers={
            "x-api-key": key,
            "anthropic-version": ANTHROPIC_VERSION,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=PREFLIGHT_TIMEOUT_SECONDS) as resp:
            if resp.status != 200:
                _abort(f"INVALID_API_KEY: /v1/models returned HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            _abort("INVALID_API_KEY: Anthropic rejected the key (401)")
        if e.code == 429:
            _abort("RATE_LIMITED: Anthropic returned 429 on pre-flight; rerun later")
        _abort(f"INVALID_API_KEY: pre-flight HTTP {e.code} — {e.reason}")
    except urllib.error.URLError as e:
        _abort(f"INVALID_API_KEY: cannot reach api.anthropic.com — {e.reason}")
    except Exception as e:  # noqa: BLE001
        _abort(f"INVALID_API_KEY: pre-flight crashed — {type(e).__name__}: {e}")

    return key


@pytest.fixture(scope="session")
def harness_image(docker_available: str, valid_api_key: str) -> str:
    """Build the stress-matrix Docker image once per session, return the tag.

    Builds from the repo root so the COPY of pyproject.toml + flow_sdk/
    resolves correctly. Layer cache makes rebuilds fast after the first run.
    """
    print(f"\n[stress_matrix] building {IMAGE_TAG} from {REPO_ROOT}", file=sys.stderr)
    proc = subprocess.run(
        [
            docker_available,
            "build",
            "-t",
            IMAGE_TAG,
            "-f",
            str(DOCKERFILE_PATH),
            str(REPO_ROOT),
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if proc.returncode != 0:
        # Print last 60 lines of build output so the failure is diagnosable.
        tail = "\n".join(proc.stdout.splitlines()[-30:] + proc.stderr.splitlines()[-30:])
        _abort(f"HARNESS_BUILD_FAILED: docker build exited {proc.returncode}\n{tail}")
    return IMAGE_TAG


def run_cell(
    docker_bin: str,
    image: str,
    api_key: str,
    scenario: str,
    workdir: Path,
    prompt: str,
    timeout_seconds: float = 25.0,
) -> subprocess.CompletedProcess:
    """Invoke one matrix cell. Returns the CompletedProcess for assertion.

    Mounts ``workdir`` as ``/work`` inside the container and passes SCENARIO
    + ANTHROPIC_API_KEY via env. The runner writes its sentinel into /work,
    visible on the host via the bind mount.
    """
    return subprocess.run(
        [
            docker_bin,
            "run",
            "--rm",
            "-e",
            f"ANTHROPIC_API_KEY={api_key}",
            "-e",
            f"SCENARIO={scenario}",
            "-v",
            f"{workdir}:/work",
            "-v",
            f"{RUNNER_SCRIPT}:/opt/runner_entrypoint.py:ro",
            "-v",
            f"{VICTIMIZE_SCRIPT}:/opt/victimize.sh:ro",
            image,
            "/work",
            prompt,
        ],
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )


def read_sentinel(workdir: Path) -> dict | None:
    """Return the parsed sentinel dict written by runner_entrypoint, or None."""
    sentinel = workdir / "_runner_complete.json"
    if not sentinel.exists():
        return None
    try:
        return json.loads(sentinel.read_text())
    except json.JSONDecodeError:
        return None
