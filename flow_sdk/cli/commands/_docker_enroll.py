"""Helpers for ``flow connect --docker <container>``.

The host CLI never runs the worker for a container. It installs ``flow`` into the
running container from a wheel, writes ``/etc/flowpad/machine.env`` (hub URL as
seen from inside the container, plain-file keyring, instance port), starts
``flow connect`` detached inside the container, and then either approves the
container's device code itself (host logged in) or shows the code for a human.
Everything here is a small pure function or a thin ``docker`` subprocess call so
the orchestration in ``connect_cmd`` stays readable and unit-testable.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

VENV_FLOW = "/opt/flow/bin/flow"
ENV_FILE = "/etc/flowpad/machine.env"
CODE_FILE = "/tmp/flowpad-connect.code.json"
READY_FILE = "/tmp/flowpad-connect.ready.json"
LOG_FILE = "/tmp/flowpad-connect.log"
PID_FILE = "/tmp/flowpad-connect.pid"
CONTAINER_WORKSPACE_PORT = 9007
CONTAINER_INSTANCE = "docker"
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"}


class DockerEnrollError(RuntimeError):
    """Anything that stops the container from being enrolled; the message is for the user."""


# ------------------------------------------------------------------ pure helpers


def rewrite_hub_url_for_container(hub_url: str) -> str:
    """A hub reachable on the host's loopback is ``host.docker.internal`` from inside a container."""
    parts = urlsplit(hub_url)
    host = parts.hostname or ""
    if host.lower() not in LOOPBACK_HOSTS:
        return hub_url
    netloc = "host.docker.internal" + (f":{parts.port}" if parts.port else "")
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def hub_origin() -> str:
    """The hub origin this machine is configured with — what ``FLOWPAD_HUB_URL`` expects."""
    from flow_sdk.cloud_client.transport.hub_http import hub_base_url

    origin = hub_base_url()
    if not origin:
        raise DockerEnrollError("no hub configured (FLOWPAD_HUB_URL)")
    return origin


def container_env(hub_url: str, instance: str = CONTAINER_INSTANCE, port: int = CONTAINER_WORKSPACE_PORT) -> str:
    """Contents of ``/etc/flowpad/machine.env`` for the container."""
    return (
        f"FLOWPAD_HUB_URL={rewrite_hub_url_for_container(hub_url)}\n"
        # Slim images have no keychain/SecretService; the plain-file backend keeps
        # `flow` from crashing on its first secret write.
        "PYTHON_KEYRING_BACKEND=keyrings.alt.file.PlaintextKeyring\n"
        f"LOCAL_SERVER_PORT={port}\n"
        f"FLOW_INSTANCE={instance}\n"
    )


def default_node_name(container: str) -> str:
    return f"@docker-{container}"


def detached_command(node_name: str) -> str:
    """The shell line run with ``docker exec -d``: source the env, record the pid, exec ``flow connect``."""
    return (
        f"set -a; . {ENV_FILE}; set +a; echo $$ > {PID_FILE}; "
        f"exec {VENV_FLOW} connect --name {shlex.quote(node_name)} --code-file {CODE_FILE} --ready-file {READY_FILE} -v "
        f"> {LOG_FILE} 2>&1"
    )


def ghost_kill_script() -> str:
    """Retire a previous ``flow connect`` inside the container and clear its marker files."""
    return f"""
for proc in /proc/[0-9]*; do
  old_pid="${{proc##*/}}"
  [ "$old_pid" = "$$" ] && continue
  old_cmd="$(tr '\\0' ' ' < "$proc/cmdline" 2>/dev/null || true)"
  case "$old_cmd" in
    *'{VENV_FLOW} connect'*|*'flow connect'*) kill "$old_pid" 2>/dev/null || true ;;
  esac
done
if [ -f {PID_FILE} ]; then
  IFS= read -r old_pid < {PID_FILE} || true
  case "$old_pid" in ''|*[!0-9]*) ;; *) kill "$old_pid" 2>/dev/null || true ;; esac
fi
rm -f {CODE_FILE} {READY_FILE} {PID_FILE} {LOG_FILE}
""".strip()


def parse_marker(text: str) -> dict[str, Any] | None:
    """A marker file's JSON, or None while it is absent/partial."""
    text = (text or "").strip()
    if not text:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def write_marker(path: Path, payload: dict[str, Any]) -> None:
    """Atomic JSON write so a reader never sees a half-written marker."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(tmp, path)


# ------------------------------------------------------------------ wheel + install script (host side)


def _checkout_root() -> Path:
    import flow_sdk

    return Path(flow_sdk.__file__).resolve().parent.parent


def find_wheel() -> str | None:
    """Newest ``flowpad-*.whl`` under the checkout's ``dist/`` (``uv build --wheel``)."""
    dist_dir = _checkout_root() / "dist"
    if not dist_dir.is_dir():
        return None
    wheels = sorted(dist_dir.glob("flowpad-*.whl"), key=lambda p: p.stat().st_mtime, reverse=True)
    return str(wheels[0]) if wheels else None


def find_install_script() -> str | None:
    candidate = _checkout_root() / "install_flow_on_docker.sh"
    return str(candidate) if candidate.is_file() else None


# ------------------------------------------------------------------ docker calls


@dataclass
class Docker:
    binary: str
    container: str

    @classmethod
    def for_container(cls, container: str) -> Docker:
        binary = shutil.which("docker")
        if not binary:
            raise DockerEnrollError("`docker` not found in PATH")
        return cls(binary, container)

    def _run(self, *args: str, check: bool = False, **kwargs: Any) -> subprocess.CompletedProcess:
        return subprocess.run([self.binary, *args], capture_output=True, text=True, check=check, **kwargs)

    def ensure_running(self) -> None:
        result = self._run("inspect", "-f", "{{.State.Running}}", self.container)
        if result.returncode != 0 or "true" not in result.stdout.lower():
            raise DockerEnrollError(f"container '{self.container}' is not running")

    def exec(self, *cmd: str, detach: bool = False) -> subprocess.CompletedProcess:
        return self._run("exec", *(["-d"] if detach else []), self.container, *cmd)

    def install_flow(self, wheel: str, install_script: str) -> str:
        cps = [
            subprocess.Popen([self.binary, "cp", wheel, f"{self.container}:/tmp/"]),
            subprocess.Popen([self.binary, "cp", install_script, f"{self.container}:/tmp/install_flow_on_docker.sh"]),
        ]
        if any(p.wait() != 0 for p in cps):
            raise DockerEnrollError("docker cp failed")
        result = self.exec("bash", "/tmp/install_flow_on_docker.sh")
        if result.returncode != 0:
            raise DockerEnrollError(f"install failed:\n{result.stderr or result.stdout}")
        return result.stdout.strip()

    def prepare(self, env_content: str) -> bool:
        """Write the env file, retire a previous worker, and report whether the host resolves.

        One ``docker exec`` rather than three: none of the steps reads the
        previous one's output, and a process spawn per step is the bulk of the
        wall clock here.
        """
        script = (
            f"mkdir -p {os.path.dirname(ENV_FILE)} && cat > {ENV_FILE} << 'ENVEOF'\n{env_content}ENVEOF\n"
            f"{ghost_kill_script()}\n"
            "getent hosts host.docker.internal > /dev/null 2>&1 && echo HOST_GATEWAY_OK || true"
        )
        result = self.exec("bash", "-c", script)
        if result.returncode != 0:
            raise DockerEnrollError(f"could not prepare {self.container}: {result.stderr or result.stdout}")
        return "HOST_GATEWAY_OK" in result.stdout

    def kill_ghosts(self) -> None:
        self.exec("bash", "-c", ghost_kill_script())

    def start_connect(self, node_name: str) -> None:
        result = self.exec("bash", "-c", detached_command(node_name), detach=True)
        if result.returncode != 0:
            raise DockerEnrollError(f"could not start flow connect in the container: {result.stderr}")

    def read_marker(self, path: str) -> dict[str, Any] | None:
        result = self.exec("cat", path)
        return parse_marker(result.stdout) if result.returncode == 0 else None

    def read_markers(self) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        """``(ready, code)`` in ONE exec — the poll loop runs every second."""
        result = self.exec(
            "bash",
            "-c",
            f"echo READY; cat {READY_FILE} 2>/dev/null; echo; echo CODE; cat {CODE_FILE} 2>/dev/null",
        )
        if result.returncode != 0:
            return None, None
        _, _, rest = result.stdout.partition("READY\n")
        ready_text, _, code_text = rest.partition("CODE\n")
        return parse_marker(ready_text), parse_marker(code_text)

    def log_tail(self, lines: int = 40) -> str:
        result = self.exec("tail", "-n", str(lines), LOG_FILE)
        return (result.stdout or result.stderr or "").strip()


# ------------------------------------------------------------------ approval from the host


async def approve_container_code(user_code: str, node_name: str) -> dict[str, Any]:
    """The host, already logged in, approves the container's code as its own machine.

    ``lookup`` first so the human still sees what is being approved (hostname/OS),
    then ``approve`` — the same two hub calls the Add-Machine dialog makes. The key
    is the shared hub client's (``client_hooks._on_request``), i.e. exactly the one
    ``_current_hub_api_key`` reported, so it is never passed around by hand.
    """
    from flow_sdk.cloud_client.transport.hub_http import hub_post

    machine = await hub_post("machine-enroll", {"user_code": user_code}, action="lookup")
    approved = await hub_post("machine-enroll", {"user_code": user_code, "node_name": node_name}, action="approve")
    return {"machine": machine or {}, **(approved or {})}
