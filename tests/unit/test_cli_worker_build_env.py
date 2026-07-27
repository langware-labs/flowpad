"""Unit tests for ClaudeCLIWorker helper construction.

build_env must pin the worker subprocess to the instance that spawned it, so a
worker's `flow` CLI never falls back to "prod" and hits the wrong instance.
"""
from __future__ import annotations

from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli_worker import ClaudeCLIWorker
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticContext
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings


def test_build_env_pins_flow_instance_to_backend(monkeypatch):
    """FLOW_INSTANCE in the worker env equals the backend's resolved instance."""
    monkeypatch.setenv("FLOW_INSTANCE", "oss")
    reset_instance_settings()
    env = ClaudeCLIWorker.build_env(AgenticContext(workdir="/tmp"))
    assert env["FLOW_INSTANCE"] == "oss"
    assert env["FLOW_INSTANCE"] == get_instance_settings().instance_name


def test_build_env_always_sets_explicit_instance_when_unset(monkeypatch):
    """With no FLOW_INSTANCE in env, the worker still gets an explicit value —
    whatever the backend resolves to (never empty/missing)."""
    monkeypatch.delenv("FLOW_INSTANCE", raising=False)
    reset_instance_settings()
    env = ClaudeCLIWorker.build_env(AgenticContext(workdir="/tmp"))
    assert env["FLOW_INSTANCE"]
    assert env["FLOW_INSTANCE"] == get_instance_settings().instance_name


def test_build_env_is_authoritative_over_context_override(monkeypatch):
    """The backend's instance wins over a context.env_vars FLOW_INSTANCE — a
    worker must never target a different backend than its parent."""
    monkeypatch.setenv("FLOW_INSTANCE", "oss")
    reset_instance_settings()
    ctx = AgenticContext(workdir="/tmp", env_vars={"FLOW_INSTANCE": "bob"})
    env = ClaudeCLIWorker.build_env(ctx)
    assert env["FLOW_INSTANCE"] == "oss"


def test_build_args_resolves_portable_model_tier():
    args = ClaudeCLIWorker.build_args(
        "claude",
        "hello",
        "session-1",
        AgenticContext(model="sm"),
    )

    assert args[args.index("--model") + 1] == "haiku"
