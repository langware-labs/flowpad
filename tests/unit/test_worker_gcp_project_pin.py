"""Pure unit coverage for the GCP deployment-project pin in worker env.

Agent-improvised ``gcloud`` calls must default to the isolated deployment
project (``gcp_deployment_project_id``), never to the production project the
user's ambient gcloud login points at.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers import AgentOptions, apply_worker_env
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    restart_payload_from_cli_options,
)
from flow_sdk.config import default_service_config

_GCP_PROJECT_VARS = ("CLOUDSDK_CORE_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT")


class _Process:
    id = "00000000-0000-4000-8000-000000000001"
    driver = SimpleNamespace(name="codex")

    @staticmethod
    def get_type() -> str:
        return "agentic_process"


def test_worker_env_pins_gcp_deployment_project(monkeypatch):
    monkeypatch.setattr(default_service_config, "gcp_deployment_project_id", "flowpad-playground")
    env: dict[str, str] = {}

    apply_worker_env(env, _Process())

    for var in _GCP_PROJECT_VARS:
        assert env[var] == "flowpad-playground"


def test_explicit_per_worker_project_override_wins(monkeypatch):
    monkeypatch.setattr(default_service_config, "gcp_deployment_project_id", "flowpad-playground")
    env = {var: "my-own-project" for var in _GCP_PROJECT_VARS}

    apply_worker_env(env, _Process())

    for var in _GCP_PROJECT_VARS:
        assert env[var] == "my-own-project"


def test_empty_deployment_project_injects_nothing(monkeypatch):
    monkeypatch.setattr(default_service_config, "gcp_deployment_project_id", "")
    env: dict[str, str] = {}

    apply_worker_env(env, _Process())

    for var in _GCP_PROJECT_VARS:
        assert var not in env


@pytest.mark.parametrize("var", _GCP_PROJECT_VARS)
def test_restart_payload_strips_gcp_project_vars(var):
    options = AgentOptions(env_vars={var: "flowpad-playground", "KEEP": "1"})

    payload = restart_payload_from_cli_options(options)

    assert var not in payload["env_vars"]
    assert payload["env_vars"]["KEEP"] == "1"
