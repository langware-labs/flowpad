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
import sys
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
# Thin aliases over `flow_sdk.instances.paths` / `.env`, which own the
# `<flow_home>/instances/<name>` layout and the repo-root env-file location for
# the whole launcher. Keeping local copies here meant two answers to "where does
# this instance live" — and only the package's version validates the name, so
# the delete paths below were the ones missing the traversal guard.
def _instance_dir(name: str) -> Path:
    from flow_sdk.instances import paths

    return paths.instance_dir(name)


def _env_file(name: str) -> Path:
    from flow_sdk.instances import paths

    return paths.env_file(name)


def _read_json(path: Path) -> dict:
    from flow_sdk.instances.atomic import read_json

    return read_json(path)


def _read_env_file(name: str) -> dict[str, str]:
    """Parse `.env.<name>.local` into a dict without mutating `os.environ`."""
    from flow_sdk.instances.env import read_env_file

    return read_env_file(name)


# ── kill ────────────────────────────────────────────────────────────────────
def _kill_instance_processes(name: str, *, backend_only: bool) -> list[int]:
    """Kill ONLY this instance's processes. Returns the PIDs we terminated.

    An adapter over ``flow_sdk.instances.procs.kill_owned``, which is the single
    choke point every signal in the launcher passes through. This used to be a
    parallel implementation with its own psutil sweep and — critically — a
    port-listener fallback that killed whatever held the port recorded in
    ``.env.<name>.local``, with no ownership check at all. That is the exact
    ``kill tmpl-3`` → SIGTERM-dev-2's-frontend hazard the instances package was
    written to close, and leaving a second copy here meant ``reset`` and
    ``restart-backend`` — the two commands a QA cycle runs unattended on a
    machine with a recycled port band — still had it.

    Ports from the env file are still swept, but through ``kill_port_if_owned``,
    which refuses unless every listener is ownership-verified as this instance's.
    """
    from flow_sdk.instances import liveness, procs
    from flow_sdk.instances.errors import KillFailed
    from flow_sdk.instances.model import Role

    idir = _instance_dir(name)
    launcher = _read_json(idir / "launcher.json")
    server = _read_json(idir / "server.json")
    env = _read_env_file(name)

    table = liveness.scan()
    # Let this instance's own records vouch for PIDs whose environ we cannot
    # read (a backend that took FLOW_INSTANCE from dotenv rather than the env).
    table.adopt_server_json(name, _as_int(server.get("server_pid")), _as_int(server.get("port")))
    for key in ("backend_pid", "frontend_pid", "monitor_pid"):
        pid = _as_int(launcher.get(key) or server.get(key))
        if pid is not None:
            table.adopt_recorded(name, pid, _proc_create_time(pid))

    roles = frozenset({Role.BACKEND}) if backend_only else None
    result = procs.kill_owned(name, table, roles=roles)

    port_keys = ("LOCAL_SERVER_PORT",) if backend_only else ("LOCAL_SERVER_PORT", "VITE_PORT")
    for key in port_keys:
        raw = env.get(key, "")
        if raw.isdigit():
            extra = procs.kill_port_if_owned(int(raw), name, table)
            result.killed.extend(extra.killed)
            result.survivors.extend(extra.survivors)

    if result.survivors:
        raise KillFailed(
            f"instance '{name}' still owns live process(es) after SIGKILL: "
            f"{sorted(set(result.survivors))}"
        )
    return sorted(set(result.killed))


def _as_int(value) -> int | None:
    from flow_sdk.instances.model import int_or_none

    return int_or_none(value)


def _proc_create_time(pid: int) -> float | None:
    import psutil

    try:
        return psutil.Process(pid).create_time()
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        return None


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


# ── `flow instance ctl …` ─────────────────────────────────────────────────────
# The launcher surface, backed by ``flow_sdk.instances``.
# ``scripts/instance_ctl.sh`` is a literal argv passthrough into this app, so the
# verb names and flags here ARE that script's public CLI. Six programmatic
# callers exec it — four TS harnesses, a verification script and a QA skill — and
# several run with ``stdio: 'ignore'``, which makes an interactive prompt an
# infinite hang rather than an error. No command reachable from ``launch`` may
# read stdin.
ctl_app = typer.Typer(
    name="ctl",
    help=(
        "Launcher control surface: allocate, inspect and tear down named dev/QA "
        "instances (and instance groups)."
    ),
    add_completion=False,
    no_args_is_help=True,
)
instance_app.add_typer(ctl_app, name="ctl")


@ctl_app.callback()
def _ctl_main() -> None:
    """Restore default SIGPIPE handling for the whole ``ctl`` surface.

    Python's default turns a closed downstream pipe into a ``BrokenPipeError``
    traceback on exit. Three callers pipe this command's stdout, and one of the
    consumers we are migrating uses ``| head`` — a failure mode the bash
    implementation never had, so it must be closed before the tables land.
    """
    import signal

    if hasattr(signal, "SIGPIPE"):
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)


def _ctl_fail(exc: Exception) -> typer.Exit:
    """Report an instance error on stderr with its typed exit code.

    Errors never go to stdout: ``PORT=$(flow instance ctl port x)`` must yield an
    empty variable on failure, never a diagnostic that a caller then treats as
    a port number.
    """
    from flow_sdk.instances.errors import InstanceError

    code = exc.exit_code if isinstance(exc, InstanceError) else 1
    typer.echo(str(exc), err=True)
    return typer.Exit(code=code)


def _role(value: str):
    """Parse a --role option into a Role, or raise the typed CLI failure."""
    from flow_sdk.instances.errors import NoSuchRole
    from flow_sdk.instances.model import Role

    try:
        return Role(value)
    except ValueError:
        raise NoSuchRole(f"unknown role {value!r}: expected backend|frontend") from None


@ctl_app.command("status")
def ctl_status(
    name: Annotated[str | None, typer.Argument(help="Instance name. Omit for all.")] = None,
    group: Annotated[str | None, typer.Option("--group", "-g", help="Only this group.")] = None,
    quiet: Annotated[bool, typer.Option("--quiet", "-q", help="No output; exit 0 iff the instance is up and owned.")] = False,
    all_: Annotated[bool, typer.Option("--all", "-a", help="Include stale and never-allocated instances.")] = False,
    json_out: Annotated[bool, typer.Option("--json", help="Emit the machine-readable report.")] = False,
    fmt: Annotated[str | None, typer.Option("--format", help="rich | plain | json. Default: rich on a tty, plain when piped.")] = None,
    legend: Annotated[bool, typer.Option("--legend", help="Explain the status glyphs.")] = False,
) -> None:
    """Show instance state, grouped.

    Liveness here means ownership-verified: a process counts only when it is
    provably this instance's. A port that merely has *a* listener is reported,
    never counted as up.
    """
    from flow_sdk.instances import manager, render
    from flow_sdk.instances.errors import InstanceError

    try:
        if quiet:
            if name is None:
                raise typer.BadParameter("--quiet requires an instance name")
            raise typer.Exit(code=0 if manager.is_up(name) else 1)
        report = manager.status([name] if name else None, group=group, all_=all_)
    except InstanceError as exc:
        raise _ctl_fail(exc) from None

    typer.echo(render.render(report, "json" if json_out else fmt, legend=legend), nl=False)


@ctl_app.command("list")
def ctl_list(
    group: Annotated[str | None, typer.Option("--group", "-g", help="Only this group.")] = None,
    all_: Annotated[bool, typer.Option("--all", "-a", help="Include stale and never-allocated instances.")] = False,
    json_out: Annotated[bool, typer.Option("--json", help="Emit the machine-readable report.")] = False,
    fmt: Annotated[str | None, typer.Option("--format", help="rich | plain | json. Default: rich on a tty, plain when piped.")] = None,
    legend: Annotated[bool, typer.Option("--legend", help="Explain the status glyphs.")] = False,
) -> None:
    """List every known instance, grouped. Alias of `status` with no name."""
    # Delegates rather than duplicating the body: the two had already drifted
    # (different --format help text) before either shipped.
    ctl_status(
        name=None, group=group, quiet=False, all_=all_,
        json_out=json_out, fmt=fmt, legend=legend,
    )


@ctl_app.command("port")
def ctl_port(
    name: Annotated[str, typer.Argument(help="Instance name.")],
    role: Annotated[str, typer.Option("--role", help="backend | frontend.")] = "backend",
) -> None:
    """Print the live port for an instance's role, or fail.

    Prints nothing on failure, so `PORT=$(… port x)` yields an empty variable
    and a non-zero status rather than a stale port pointing at another
    instance's backend.
    """
    from flow_sdk.instances import manager
    from flow_sdk.instances.errors import InstanceError

    try:
        typer.echo(manager.port_of(name, _role(role)))
    except InstanceError as exc:
        raise _ctl_fail(exc) from None


@ctl_app.command("is-up")
def ctl_is_up(
    name: Annotated[str, typer.Argument(help="Instance name.")],
    role: Annotated[str | None, typer.Option("--role", help="Check only this role.")] = None,
) -> None:
    """Exit 0 iff the instance is registered and ownership-verified live.

    An orphan (live processes, no registry) is NOT up: nothing about it has been
    verified. That distinction is the whole reason this predicate exists instead
    of grepping `status` for the word UP.
    """
    from flow_sdk.instances import manager
    from flow_sdk.instances.errors import InstanceError

    try:
        ok = manager.is_up(name, _role(role) if role else None)
    except InstanceError as exc:
        raise _ctl_fail(exc) from None
    raise typer.Exit(code=0 if ok else 1)


@ctl_app.command("reconcile")
def ctl_reconcile(
    dry_run: Annotated[bool, typer.Option("--dry-run", help="Report without changing anything.")] = False,
    json_out: Annotated[bool, typer.Option("--json", help="Emit a machine-readable summary.")] = False,
) -> None:
    """Make on-disk control state agree with the machine.

    Clears recorded PIDs that are not alive, deletes `server.json` files naming
    a dead backend, removes singleton locks nobody holds, and drops leases
    nothing is using. Never touches a database, a sodot or a keychain entry.
    """
    from flow_sdk.instances.reconcile import reconcile

    report = reconcile(dry_run=dry_run)
    if json_out:
        typer.echo(json.dumps(report.to_json()))
        return
    if not report.changed:
        typer.echo("nothing to reconcile — on-disk state matches the machine")
        return
    prefix = "would clear" if dry_run else "cleared"
    for item in report.cleared_pids:
        typer.echo(f"  {prefix} dead pid: {item}")
    for name in report.removed_server_json:
        typer.echo(f"  {prefix} stale server.json: {name}")
    for name in report.removed_locks:
        typer.echo(f"  {prefix} stale singleton lock: {name}")
    for port in report.dropped_leases:
        typer.echo(f"  {prefix} unused port lease: {port}")


@ctl_app.command("reap")
def ctl_reap(
    dry_run: Annotated[bool, typer.Option("--dry-run", help="List what would be killed, kill nothing.")] = False,
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Do not prompt.")] = False,
    include_protected: Annotated[bool, typer.Option("--include-protected", help="Also reap protected instances.")] = False,
    json_out: Annotated[bool, typer.Option("--json", help="Emit a machine-readable summary.")] = False,
) -> None:
    """Kill live processes belonging to instances nothing accounts for.

    An orphan is a process this launcher can prove belongs to an instance that
    has no registry and no live backend of its own — the population that the old
    `gc` created by deleting registries without killing anything, and that the
    old `kill` could not name because it needed a registry to find its ports.
    """
    from flow_sdk.instances import manager

    plan = manager.reap(dry_run=True, include_protected=include_protected)
    if json_out and dry_run:
        typer.echo(json.dumps(plan))
        return

    if not plan["orphans"]:
        if json_out:
            typer.echo(json.dumps(plan))
        else:
            typer.echo("no orphan processes")
        return

    from flow_sdk.instances.render import format_age

    for o in plan["orphans"]:
        typer.echo(
            f"  pid {o['pid']:>7}  {o['instance']}  role={o['role'] or '?'}  "
            f"port={o['port'] or '-'}  age={format_age(o['age_s'])}  {o['cmd'][:70]}"
        )
    if plan["skipped_protected"]:
        typer.echo(f"  (skipping protected: {', '.join(plan['skipped_protected'])})")

    if dry_run:
        typer.echo(f"\n{len(plan['orphans'])} process(es) would be killed (dry run)")
        return

    # Confirmation is gated on an interactive stdin as well as --yes: `launch`
    # reconciles on the way in, and four callers run it with stdio:'ignore',
    # where a prompt is an infinite hang rather than an error.
    if not yes and sys.stdin.isatty():
        typer.confirm(f"Kill {len(plan['orphans'])} orphan process(es)?", abort=True)

    result = manager.reap(include_protected=include_protected)
    if json_out:
        typer.echo(json.dumps(result))
    else:
        typer.echo(
            f"reaped {len(result['killed'])} process(es) across "
            f"{len(result['instances'])} instance(s)"
        )
    for note in result["refused"]:
        typer.echo(f"  refused: {note}", err=True)
    if result["survivors"]:
        typer.echo(f"  survivors after SIGKILL: {result['survivors']}", err=True)
        raise typer.Exit(code=1)


@ctl_app.command("gc")
def ctl_gc(
    age_days: Annotated[int, typer.Option("--age", help="Only remove dirs untouched for this many days.")] = 14,
    dry_run: Annotated[bool, typer.Option("--dry-run", help="Report without deleting anything.")] = False,
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Do not prompt.")] = False,
    include_protected: Annotated[bool, typer.Option("--include-protected", help="Also consider protected instances.")] = False,
    json_out: Annotated[bool, typer.Option("--json", help="Emit a machine-readable summary.")] = False,
) -> None:
    """Delete the DATA DIRECTORY of dead, abandoned instances.

    Reaps orphan processes first, so it can never delete the directory of a
    still-running instance. Age gates data destruction only — liveness, not
    mtime, decides whether anything is running.
    """
    from flow_sdk.instances import manager

    plan = manager.gc(age_days=age_days, dry_run=True, include_protected=include_protected)
    removable = plan["removed_dirs"]
    if json_out and dry_run:
        typer.echo(json.dumps(plan))
        return
    if not removable:
        typer.echo(f"nothing to collect (dead + untouched for {age_days}d)")
        return

    for name in removable:
        typer.echo(f"  {name}")
    if dry_run:
        typer.echo(f"\n{len(removable)} data dir(s) would be deleted (dry run)")
        return

    if not yes and sys.stdin.isatty():
        typer.confirm(f"Delete {len(removable)} instance data dir(s)?", abort=True)

    result = manager.gc(age_days=age_days, include_protected=include_protected)
    if json_out:
        typer.echo(json.dumps(result))
    else:
        typer.echo(f"removed {len(result['removed_dirs'])} data dir(s)")
