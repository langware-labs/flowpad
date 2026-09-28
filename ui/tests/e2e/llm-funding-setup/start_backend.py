#!/usr/bin/env python3
"""Starts a fresh, isolated backend bound to a FAKE hub, for one of the two llm-funding e2e
scenarios (see the two *.spec.ts files beside this script).

    python start_backend.py --scenario hub-endpoint   --instance e2e-llm-hub --be-port 6101
    python start_backend.py --scenario global-default --instance e2e-llm-global --be-port 6102

Does, in order:
  1. Picks the real, OS-appropriate install command for this scenario's "step 3" tool (the
     one whose CLI install is deliberately broken, so the agent runs it for real).
  2. Starts the fake hub (tests/utils/fake_llm_hub_server.py) on an OS-chosen port, configured
     so "hub-endpoint" REJECTS the client's own sm-tier default and only allows a model that
     exists nowhere but in this scenario's fake chain (proving the fallback reads the chain,
     not a guess) — and "global-default" accepts the sm-tier default directly (proving THAT
     is what an unrestricted budget resolves to, read from the same table the app itself
     uses, never a literal copied into this script).
  3. Seeds this box's local hub binding + login key (flow_sdk.instance_settings.llm_endpoint /
     flow_sdk.cli.auth.hub_login) — no real hub login; these are local, file-backed settings.
  4. Boots the real backend with FLOWPAD_HUB_URL pointing at the fake hub and
     FLOWPAD_SKIP_FIRST_RUN_SETUP=true (the spec navigates to the wizard directly; the
     fire-once trigger is a different scenario's coverage, not this one's).
  5. Waits for bootstrap readiness, then writes launcher.json (the headless instance
     contract) and prints the backend PID on its own stdout line for the caller to capture.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]

# Fixed, made-up hub endpoint ids — this hub is fake, so nothing has to resolve to a real row.
# Real UUID v4s: endpoint_invoke_url() parses this through TypeId, which requires one.
HUB_ENDPOINT_ID = "f4fea5e2-41f7-4f53-ba07-b4c5f4865f83"
GLOBAL_ENDPOINT_ID = "47ef936f-f894-4a24-b430-48bacc6c754f"

# The model this scenario's chain allows — deliberately NOT a real model name, so a pass
# proves the value came from the fake chain response, not from any other rung guessing right.
HUB_ALLOWED_MODEL = "test-hub-member-model"


def _install_command(tool: str) -> str:
    if platform.system() == "Darwin":
        return f"brew install {tool}"
    return f"apt-get update && apt-get install -y {tool}"


def _sm_tier_default() -> str:
    sys.path.insert(0, str(REPO_ROOT))
    from flow_sdk.builtin.agentic_process.model_tiers import DEEPAGENTS_MODEL_TIERS

    return DEEPAGENTS_MODEL_TIERS["sm"]


def _fake_hub_config(scenario: str) -> tuple[str, dict, str]:
    """``(endpoint_id, fake_hub_config, expected_model)`` — *expected_model* is what the spec
    must see on the agent step: the fake chain's own allowed model for "hub-endpoint" (a name
    that exists nowhere else, so a pass proves the chain was actually read), or the CLIENT'S
    OWN sm-tier default for "global-default" (read here, never duplicated as a literal in the
    spec — see the module docstring)."""
    sm_default = _sm_tier_default()
    if scenario == "hub-endpoint":
        return (
            HUB_ENDPOINT_ID,
            {
                HUB_ENDPOINT_ID: {
                    "allowed_model": HUB_ALLOWED_MODEL,
                    "rejected_model": sm_default,
                    "install_command": _install_command("figlet"),
                    "chain_hops": [
                        {"effective_filters": {"models_allow": []}},  # the leaf: unrestricted
                        {"effective_filters": {"models_allow": [HUB_ALLOWED_MODEL]}},  # the parent that narrows it
                    ],
                }
            },
            HUB_ALLOWED_MODEL,
        )
    if scenario == "global-default":
        return (
            GLOBAL_ENDPOINT_ID,
            {
                GLOBAL_ENDPOINT_ID: {
                    "allowed_model": sm_default,
                    "install_command": _install_command("sl"),
                    "chain_hops": [{"effective_filters": {"models_allow": []}}],
                }
            },
            sm_default,
        )
    raise ValueError(f"unknown scenario {scenario!r}")


def _pin_harness_to_deepagents(be_port: int) -> None:
    """Force this instance's default agent harness to deepagents.

    `resolve_builtin_worker_type()` otherwise prefers whatever CLI harness (claude, codex, ...)
    is discoverable on PATH, with no auth check — on a dev box or CI runner that also has
    Claude Code installed globally (ours does, for other test tiers), that silently bypasses
    every fake-hub/chain-fallback fixture these two scenarios exist to exercise.

    Goes through the running backend's own HTTP API (PATCH, the generic entity-update action)
    rather than opening a second connection to its SQLite file directly: the backend keeps an
    in-memory entity cache, so a raw out-of-process DB write is silently shadowed by whatever
    the live process still holds/re-saves (confirmed empirically — the row read right back as
    unchanged even though the write itself succeeded).
    """
    sys.path.insert(0, str(REPO_ROOT))
    from flow_sdk.builtin.capability import capability_id_for_kind

    capability_id = capability_id_for_kind("harness")
    body = json.dumps({"reference_kind": "harness.deepagents.cli"}).encode("utf-8")
    request = urllib.request.Request(
        f"http://localhost:{be_port}/api/v1/graph/capability/{capability_id}",
        data=body,
        method="PATCH",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=5) as resp:
        result = json.loads(resp.read())
    if result.get("data", {}).get("reference_kind") != "harness.deepagents.cli":
        raise RuntimeError(f"failed to pin default harness to deepagents: {result}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", choices=["hub-endpoint", "global-default"], required=True)
    parser.add_argument("--instance", required=True)
    parser.add_argument("--be-port", type=int, required=True)
    parser.add_argument("--flow-home", required=True)
    args = parser.parse_args()

    endpoint_id, fake_hub_endpoints, expected_model = _fake_hub_config(args.scenario)
    config_path = Path(args.flow_home) / "fake_hub_config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(fake_hub_endpoints), encoding="utf-8")

    port_file = Path(args.flow_home) / "fake_hub_port.txt"
    fake_hub_proc = subprocess.Popen(  # noqa: S603
        [
            sys.executable,
            "-m",
            "tests.utils.fake_llm_hub_server",
            "--config",
            str(config_path),
            "--port-file",
            str(port_file),
        ],
        cwd=str(REPO_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        if port_file.is_file() and port_file.read_text(encoding="utf-8").strip():
            break
        time.sleep(0.05)
    else:
        raise RuntimeError("fake hub server never reported its port")
    fake_hub_port = port_file.read_text(encoding="utf-8").strip()
    fake_hub_url = f"http://127.0.0.1:{fake_hub_port}"

    env = {
        **os.environ,
        "FLOW_INSTANCE": args.instance,
        "FLOW_HOME": args.flow_home,
        "SOD_ENC_KEY": os.environ.get("SOD_ENC_KEY") or "",
        "FLOWPAD_HUB_URL": fake_hub_url,
    }
    if not env["SOD_ENC_KEY"]:
        from cryptography.fernet import Fernet

        env["SOD_ENC_KEY"] = Fernet.generate_key().decode()

    # Seed the box's local (file-backed) hub binding + login key — a real Python call, run in
    # THIS process's env before the backend subprocess ever starts, so both read the same
    # instance dir. No real hub login: these are exactly the two facts `binding_for_candidate`
    # reads (`get_hub_llm_endpoint()`, `resolve_hub_api_key()`), and both are local state.
    os.environ.update(env)
    sys.path.insert(0, str(REPO_ROOT))
    from flow_sdk.cli.auth.hub_login import set_api_key
    from flow_sdk.instance_settings import reset_instance_settings
    from flow_sdk.instance_settings.llm_endpoint import set_hub_llm_endpoint

    reset_instance_settings()
    set_api_key("fake-e2e-hub-key")
    # Dash form on purpose — this is what endpoint_invoke_url() parses back through TypeId to
    # build the REAL invoke URL a spawn uses; a colon form there fails validation silently and
    # falls through to a stub with no id at all.
    set_hub_llm_endpoint(
        f"llm_endpoint-{endpoint_id}",
        f"/api/v1/graph/llm_endpoint/{endpoint_id}/invoke",
        provider="openrouter",
        name="e2e fake endpoint",
    )

    backend_env = {
        **env,
        "MINIHUB_RELOAD": "False",
        "FLOWPAD_SKIP_DOTENV": "true",
        "FLOWPAD_SKIP_LOCK": "true",
        "FLOWPAD_SKIP_FIRST_RUN_SETUP": "true",
        "LOCAL_SERVER_PORT": str(args.be_port),
    }
    backend = subprocess.Popen(  # noqa: S603
        [sys.executable, "-m", "flow_sdk.server.run"],
        cwd=str(REPO_ROOT),
        env=backend_env,
        stdout=open(Path(args.flow_home) / "backend.log", "wb"),  # noqa: SIM115
        stderr=subprocess.STDOUT,
    )

    deadline = time.monotonic() + 60
    ready = False
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://localhost:{args.be_port}/api/v1/graph/bootstrap", timeout=2) as resp:
                if b'"types"' in resp.read():
                    ready = True
                    break
        except OSError:
            pass
        time.sleep(1)
    if not ready:
        fake_hub_proc.terminate()
        backend.terminate()
        raise RuntimeError(f"backend on port {args.be_port} did not become ready within 60s")

    _pin_harness_to_deepagents(args.be_port)

    launcher_dir = Path(args.flow_home) / "instances" / args.instance
    launcher_dir.mkdir(parents=True, exist_ok=True)
    (launcher_dir / "launcher.json").write_text(
        json.dumps({"name": args.instance, "backend_port": args.be_port, "backend_pid": backend.pid}), encoding="utf-8"
    )

    print(f"BACKEND_PID={backend.pid}")  # noqa: T201
    print(f"FAKE_HUB_PID={fake_hub_proc.pid}")  # noqa: T201
    print(f"EXPECTED_MODEL={expected_model}")  # noqa: T201


if __name__ == "__main__":
    main()
