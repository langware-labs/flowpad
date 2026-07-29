"""Instance lifecycle CLI.

``flow instance reset <name>`` — reset a named local dev instance to a pristine
state so a QA sweep (Phase 11/12) gets a fresh backend every unit and never
inherits the process-level rot (leaked PTY/subprocess children, connection-pool
and memory growth) that made ``desktop-db/clear`` degrade after a few heavy
categories.

The reset is **surgical** — it only ever touches the *named* instance's own
processes, data dir, repo-root env file, and account-scoped keychain slot. It
never disturbs other running instances (``dev-1``/``dev-2``/``prod``), the shared
``<flow_home>/global`` state, ``capability-installs``, or the hub user.

Cross-platform: kill (``psutil`` via ``server/launch.py::kill_process``), wipe
(``shutil.rmtree``) and keychain-clear are portable. The **relaunch** delegates to
the proven bash ``scripts/instance_ctl.sh launch`` (Unix-only today; porting the
launcher to Python is a separate follow-up), except the ``--backend-only`` fast
path, which respawns only the backend in-process via ``start_detached_process``.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Annotated

import typer

from flow_sdk.claude_env import _rmtree_safe

instance_app = typer.Typer(
    name="instance",
    help="Manage local dev instances (reset, …).",
    add_completion=False,
    no_args_is_help=True,
)

# flow_sdk/cli/commands/instance_cmd.py → repo root
REPO_ROOT = Path(__file__).resolve().parents[3]


# ── path helpers ──────────────────────────────────────────────────────────────
# Resolve the instance dir through BaseInstanceSettings (the single source of
# truth for the `<flow_home>/instances/<name>` layout) rather than re-deriving
# `~/.flow/...` here — which base_settings' module docstring explicitly forbids.
# `from_env` keys purely off the passed name for the dir join, so it targets the
# named instance regardless of the caller's ambient FLOW_INSTANCE.
def _instance_dir(name: str) -> Path:
    from flow_sdk.instance_settings.base_settings import BaseInstanceSettings

    return BaseInstanceSettings.from_env(name).instance_dir


def _env_file(name: str) -> Path:
    return REPO_ROOT / f".env.{name}.local"


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _read_env_file(name: str) -> dict[str, str]:
    """Parse `.env.<name>.local` into a dict without mutating `os.environ`."""
    from dotenv import dotenv_values

    ef = _env_file(name)
    if not ef.exists():
        return {}
    return {k: v for k, v in dotenv_values(ef).items() if v is not None}


# ── kill ────────────────────────────────────────────────────────────────────
def _kill_instance_processes(name: str, *, backend_only: bool) -> list[int]:
    """Kill ONLY this instance's processes. Returns the PIDs we terminated.

    Sources, most-authoritative first: launcher.json (backend/frontend PID),
    server.json (server/monitor PID), then a scoped psutil sweep matching
    ``FLOW_INSTANCE==<name>`` exactly, then a port-listener fallback. Never a
    broad ``pkill flow_sdk.server.run`` (that would hit sibling instances).

    Killing is **batched** (collect all targets → SIGTERM all → wait once →
    SIGKILL survivors) so a degraded instance with dozens of leaked PTY/claude
    children reaps in seconds, not minutes.
    """
    import psutil

    gone = (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess)
    self_pid = os.getpid()
    idir = _instance_dir(name)
    launcher = _read_json(idir / "launcher.json")
    server = _read_json(idir / "server.json")
    env = _read_env_file(name)

    ports: set[int] = set()
    if env.get("LOCAL_SERVER_PORT", "").isdigit():
        ports.add(int(env["LOCAL_SERVER_PORT"]))
    if not backend_only and env.get("VITE_PORT", "").isdigit():
        ports.add(int(env["VITE_PORT"]))

    targets: dict[int, psutil.Process] = {}

    def _add(pid) -> None:
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            return
        if pid <= 0 or pid == self_pid or pid in targets:
            return
        try:
            targets[pid] = psutil.Process(pid)
        except gone:
            pass

    # 1. Recorded PIDs + the backend's PTY/claude child tree.
    for pid in (server.get("server_pid"), server.get("monitor_pid"), launcher.get("backend_pid")):
        _add(pid)
    if not backend_only:
        _add(launcher.get("frontend_pid"))
    for pid in list(targets):
        try:
            for child in targets[pid].children(recursive=True):
                _add(child.pid)
        except gone:
            pass

    # 2. Scoped stray sweep by exact FLOW_INSTANCE env match (environ() is cheap).
    for proc in psutil.process_iter(["pid", "cmdline"]):
        pid = proc.info["pid"]
        if pid == self_pid or pid in targets:
            continue
        try:
            if proc.environ().get("FLOW_INSTANCE") != name:
                continue
        except (*gone, OSError):
            continue
        # backend_only must spare the vite frontend (which also has FLOW_INSTANCE set).
        if backend_only and "flow_sdk.server.run" not in " ".join(proc.info.get("cmdline") or []):
            continue
        _add(pid)

    # 3. Port-listener fallback (ports are instance-unique).
    if ports:
        try:
            for conn in psutil.net_connections(kind="inet"):
                if (
                    conn.status == psutil.CONN_LISTEN and conn.laddr
                    and conn.laddr.port in ports and conn.pid and conn.pid != self_pid
                ):
                    _add(conn.pid)
        except (psutil.AccessDenied, OSError):
            pass

    # Batched terminate → wait → kill.
    procs = list(targets.values())
    for p in procs:
        try:
            p.terminate()
        except gone:
            pass
    _gone, alive = psutil.wait_procs(procs, timeout=3)
    for p in alive:
        try:
            p.kill()
        except gone:
            pass
    _gone, survivors = psutil.wait_procs(alive, timeout=2)
    if survivors:
        survivor_pids = sorted(p.pid for p in survivors)
        raise RuntimeError(
            f"instance '{name}' still owns live process(es) after SIGKILL: {survivor_pids}"
        )
    return sorted(targets)


# ── wipe ──────────────────────────────────────────────────────────────────────
# A --backend-only reset wipes the per-run DATA / degradation state (graph DB, fs
# records, scheduler jobs, stale process-discovery triple) but KEEPS the
# session+identity+bookkeeping files below, so the instance stays cloud-logged-in
# with its view_mode across a fast reset. The rule is inverted deliberately — a
# small, stable KEEP-set instead of a growing wipe-list — so a NEWLY-added
# per-run data file is flushed automatically rather than silently surviving
# (exactly the stale-state degradation this command exists to prevent).
#   sodot / .secrets_enabled (cloud creds), config.json (active user),
#   preferences.json (view_mode), launcher.json + logs (relaunch bookkeeping),
#   transcript_cursors.json (global transcript consumption checkpoint),
#   schema / toplog.json / skill_rules (regenerated config, not degradation state).
#
# The transcript cursor is process bookkeeping, not entity/test data. Dropping
# it on every category reset makes the fresh backend replay every historical
# JSONL under ~/.claude and ~/.codex (11K+ on a developer machine), contending
# with the first desktop-db/clear and re-emitting already-consumed deltas.
_KEEP = {
    "sodot", ".secrets_enabled", "config.json", "preferences.json",
    "launcher.json", "launcher-backend.log", "launcher-frontend.log", "logs",
    "schema", "toplog.json", "skill_rules", "transcript_cursors.json",
}


def _rm(path: Path) -> None:
    if path.is_dir():
        _rmtree_safe(path)
    else:
        try:
            path.unlink()
        except OSError:
            pass


def _wipe(name: str, *, backend_only: bool) -> None:
    idir = _instance_dir(name)
    if backend_only:
        if idir.is_dir():
            for child in idir.iterdir():
                if child.name not in _KEEP:
                    _rm(child)
    else:
        if idir.exists():
            _rmtree_safe(idir)
        # repo-root env file lives OUTSIDE the data dir.
        _rm(_env_file(name))


# ── keychain (account-scoped) ─────────────────────────────────────────────────
def _purge_keychain(name: str) -> str:
    """Delete this instance's SOD-key from the OS keychain — both the signed
    ``<name>.flow-rs`` slot and the legacy bare ``<name>`` slot, under service
    ``Flowpad.ai.sod_key``. Account-scoped, so sibling instances are untouched."""
    if os.environ.get("SOD_ENC_KEY") or os.environ.get("FLOWPAD_DESKTOP") == "1":
        return "skipped (env-provided key / desktop)"
    try:
        from flow_sdk.flow_rs_binary import (
            FLOW_RS_ACCOUNT_SUFFIX,
            flow_rs_delete_restricted,
            vendored_flow_rs_enabled,
        )
        from flow_sdk.instance_settings.base_settings import SOD_KEY_KEYCHAIN_SERVICE
    except Exception as e:  # pragma: no cover
        return f"unavailable ({e})"

    done = []
    if vendored_flow_rs_enabled():
        try:
            flow_rs_delete_restricted(SOD_KEY_KEYCHAIN_SERVICE, f"{name}{FLOW_RS_ACCOUNT_SUFFIX}")
            done.append("signed")
        except Exception as e:
            done.append(f"signed-fail:{e}")
    # Always also clear the legacy bare slot via keyring.
    try:
        import keyring
        import keyring.errors

        try:
            keyring.delete_password(SOD_KEY_KEYCHAIN_SERVICE, name)
            done.append("legacy")
        except keyring.errors.PasswordDeleteError:
            pass  # absent → fine
    except Exception as e:
        done.append(f"legacy-fail:{e}")
    return ", ".join(done) or "nothing to delete"


# ── relaunch + readiness ──────────────────────────────────────────────────────
def _pin_view_mode_for_qa(name: str) -> None:
    """Pin a reset QA instance to Standard.

    Deliberately NOT the shipped default (Vibe, `preferences.ui.view_mode` in
    prefRegistry.ts): the browser sweeps this reset serves assert Standard /
    Advanced surfaces, so they pin the mode explicitly rather than inherit
    whatever a fresh user gets.
    """
    p = _instance_dir(name) / "preferences.json"
    try:
        d = _read_json(p)
        d["preferences.ui.view_mode"] = "standard"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(d, indent=2))
    except Exception:
        pass


def _wait_ready(port: int, timeout: float) -> bool:
    """Poll bootstrap until the schema 'types' are present (unauth'd-safe gate)."""
    import urllib.request

    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/api/v1/graph/bootstrap"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                if r.status == 200 and b'"types"' in r.read(65536):
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def _relaunch_full(name: str) -> None:
    subprocess.run(
        ["scripts/instance_ctl.sh", "launch", name],
        cwd=str(REPO_ROOT),
        check=False,
    )


def _relaunch_backend_only(name: str) -> int:
    """Respawn only the backend (vite is left running). Mirrors instance_ctl's
    backend spawn: source .env.<name>.local into env, run flow_sdk.server.run."""
    from flow_sdk.server.launch import start_detached_process

    env = os.environ.copy()
    env.update(_read_env_file(name))
    env["FLOW_INSTANCE"] = name
    log = _instance_dir(name) / "launcher-backend.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "ab") as fh:
        return start_detached_process(
            ["uv", "run", "-m", "flow_sdk.server.run"],
            env=env,
            stderr=fh,
        )


def _record_backend_pid(name: str, backend_pid: int) -> None:
    """Keep launcher bookkeeping pointed at the current backend owner."""
    lpath = _instance_dir(name) / "launcher.json"
    launcher = _read_json(lpath)
    if launcher:
        launcher["backend_pid"] = backend_pid
        lpath.write_text(json.dumps(launcher, indent=2))


# ── command ───────────────────────────────────────────────────────────────────
@instance_app.command("restart-backend")
def restart_backend(
    name: Annotated[str, typer.Argument(help="Instance name (e.g. qa-cycle, dev-1).")],
    json_out: Annotated[bool, typer.Option("--json", help="Emit a machine-readable summary.")] = False,
) -> None:
    """Restart only a named instance's backend, preserving all instance data."""
    from flow_sdk.builtin.process_lifecycle import request_backend_restart

    t0 = time.monotonic()
    instance_dir = _instance_dir(name)
    server_pid = _read_json(instance_dir / "server.json").get("server_pid")
    try:
        server_pid = int(server_pid)
    except (TypeError, ValueError):
        raise RuntimeError(
            f"instance '{name}' has no recorded backend server PID"
        ) from None
    marker = request_backend_restart(instance_dir, server_pid)
    try:
        killed = _kill_instance_processes(name, backend_only=True)
        new_pid = _relaunch_backend_only(name)
        _record_backend_pid(name, new_pid)
    except BaseException:
        # A failed replacement must not leave the surviving/next backend
        # looking like the intentionally terminated generation.
        marker.unlink(missing_ok=True)
        raise

    summary = {
        "instance": name,
        "killed_pids": killed,
        "backend_pid": new_pid,
        "elapsed_s": round(time.monotonic() - t0, 2),
    }
    if json_out:
        typer.echo(json.dumps(summary))
    else:
        typer.echo(
            f"restart-backend '{name}': killed {len(killed)} pid(s), "
            f"new backend pid={new_pid}"
        )


# ── command ───────────────────────────────────────────────────────────────────
@instance_app.command("reset")
def reset(
    name: Annotated[str, typer.Argument(help="Instance name (e.g. qa-cycle, dev-1).")],
    relaunch: Annotated[bool, typer.Option("--relaunch/--no-relaunch", help="Relaunch after wipe.")] = True,
    backend_only: Annotated[bool, typer.Option("--backend-only", help="Kill/wipe/respawn only the backend; leave vite running (fast path).")] = False,
    purge_keychain: Annotated[bool, typer.Option("--purge-keychain/--keep-keychain", help="Also clear this instance's OS-keychain SOD key.")] = True,
    ready_timeout: Annotated[float, typer.Option("--ready-timeout", help="Seconds to wait for bootstrap readiness after relaunch.")] = 90.0,
    json_out: Annotated[bool, typer.Option("--json", help="Emit a machine-readable summary.")] = False,
) -> None:
    """Reset a named local dev instance: kill its processes, wipe its state,
    clear its keychain slot, then relaunch. Surgical — never touches other
    instances."""
    t0 = time.monotonic()

    killed = _kill_instance_processes(name, backend_only=backend_only)
    # brief settle so ports/locks release before the fresh start
    time.sleep(0.5)

    _wipe(name, backend_only=backend_only)

    keychain = "kept"
    if purge_keychain and not backend_only:
        keychain = _purge_keychain(name)

    ready = None
    port = None
    if relaunch:
        if backend_only:
            new_pid = _relaunch_backend_only(name)
            # Re-sync launcher.json's backend_pid to the freshly-spawned process.
            # backend_only keeps launcher.json (it's in _KEEP so the still-running
            # vite bookkeeping survives), but the file otherwise carries the OLD,
            # now-dead backend_pid. Consumers that SIGTERM launcher.json['backend_pid']
            # to restart the backend (e.g. the ws-reconnect-after-restart api test)
            # would kill a stale pid and never actually restart the live backend.
            _record_backend_pid(name, new_pid)
        else:
            _relaunch_full(name)
        _pin_view_mode_for_qa(name)
        env = _read_env_file(name)
        if env.get("LOCAL_SERVER_PORT"):
            port = int(env["LOCAL_SERVER_PORT"])
            ready = _wait_ready(port, ready_timeout)

    elapsed = round(time.monotonic() - t0, 2)
    summary = {
        "instance": name,
        "backend_only": backend_only,
        "killed_pids": killed,
        "keychain": keychain,
        "relaunched": relaunch,
        "port": port,
        "ready": ready,
        "elapsed_s": elapsed,
    }
    if json_out:
        typer.echo(json.dumps(summary))
    else:
        typer.echo(
            f"reset '{name}': killed {len(killed)} pid(s), keychain={keychain}, "
            f"relaunch={'on' if relaunch else 'off'} "
            f"{'(backend-only) ' if backend_only else ''}"
            f"ready={ready} in {elapsed}s"
        )
    if relaunch and ready is False:
        raise typer.Exit(code=1)
