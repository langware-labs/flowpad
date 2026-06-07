"""Migration runner — invokes a headless AgenticProcess to apply a
version-specific recipe.

Public entry point: ``run_if_needed(version: str | None = None) -> int``.

Exit codes
----------

- ``0`` — migration completed, or no-op (already completed / no recipe /
  another instance already in flight).
- ``1`` — unrecoverable error (recipe ran but failed, agent never
  produced a transcript, bootstrap raised, etc.).
- ``130`` — interrupted (SIGINT). Status file flips to ``error``.

Concurrency
-----------

``filelock.FileLock`` on ``<status_dir>/migration_<version>.lock``
guarantees only one ``flow migrate run`` can be inside the critical
section at a time. The pid-alive check on the status record is only the
secondary guard for crashed-coordinator recovery.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import typer
from filelock import FileLock, Timeout

from flow_sdk.agentic_run_consts import (
    AGENT_WARMUP_INTERVAL_S,
    AGENT_WARMUP_TICKS,
    DEFAULT_TRANSCRIPT_TIMEOUT_S,
)

from . import status as migration_status
from .status import Decision, MigrationRecord, MigrationStatus


@dataclass(frozen=True)
class Recipe:
    """A version's discovered migration artifacts.

    A version may ship a Python script (``scripts/migrate.py``) and/or an
    agent recipe (``skill/SKILL.md``). When both are present, the script
    runs first (filesystem prep) and the agent recipe is a follow-up. For
    now we run at most one per invocation — script takes priority.
    """

    script_path: Path | None = None  # <version>/scripts/migrate.py
    skill_dir: Path | None = None    # <version>/skill/ (contains SKILL.md)


def _is_process_alive(pid: int | None) -> bool:
    """Use the canonical helper from server/launch.py."""
    if pid is None:
        return False
    try:
        from flow_sdk.server.launch import is_process_alive
        return is_process_alive(pid)
    except Exception:
        # Fallback to os.kill(pid, 0)
        try:
            os.kill(pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False


def _resolve_recipe(version: str) -> Recipe | None:
    """Discover migration artifacts for ``version``.

    Looks under ``<migrations_root>/<version>/`` for:
      * ``scripts/migrate.py`` — Python script with a ``run()`` entry point
      * ``skill/SKILL.md`` — agent recipe driven by AgenticProcess

    ``<migrations_root>`` defaults to
    ``<flowpad_assistant>/migrations`` but can be overridden via the
    ``FLOWPAD_MIGRATIONS_ROOT`` env var. The override exists so deployments
    or tests can stage recipes outside the shipped assistant tree
    (e.g. the stress-matrix harness places recipes under ``/work``).

    Returns None when neither artifact exists — caller treats this as
    "nothing to do for this version" and exits silently.
    """
    override = os.environ.get("FLOWPAD_MIGRATIONS_ROOT")
    if override:
        migrations_root = Path(override)
    else:
        from flow_sdk.config import flowpad_assistant_project_root
        migrations_root = flowpad_assistant_project_root() / "migrations"

    base = migrations_root / version
    script_path = base / "scripts" / "migrate.py"
    skill_dir = base / "skill"

    has_script = script_path.is_file()
    has_skill = (skill_dir / "SKILL.md").is_file()
    if not has_script and not has_skill:
        return None
    return Recipe(
        script_path=script_path if has_script else None,
        skill_dir=skill_dir if has_skill else None,
    )


# Back-compat: external callers / tests that import the old function name
# still expect a directory pointing at the skill recipe.
def _resolve_recipe_dir(version: str) -> Path | None:
    recipe = _resolve_recipe(version)
    return recipe.skill_dir if recipe else None


def _resolve_status_dir() -> Path:
    """Return the per-instance status directory via InstanceSettings.

    ``instance_settings`` is a leaf module; always importable by the time
    migrations run. The legacy ``Path.home() / ".flow"`` fallback was a
    latent SoT violation.
    """
    from flow_sdk.instance_settings import get_instance_settings
    return get_instance_settings().migrations_status_dir


def _render_entry(entry: Any) -> None:
    """Compact user-visible rendering of one transcript JSONL line.

    Skips system bookkeeping, surfaces assistant text + tool calls + tool
    results in single lines. The goal is "the operator sees that progress
    is happening," not "every byte of the transcript."
    """
    if not isinstance(entry, dict):
        return
    msg = entry.get("message")
    if not isinstance(msg, dict):
        return
    role = msg.get("role")
    content = msg.get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if role == "assistant" and btype == "text":
            text = (block.get("text") or "").strip()
            if text:
                typer.echo(f"  ▸ {text[:240]}")
        elif role == "assistant" and btype == "tool_use":
            name = block.get("name", "?")
            typer.echo(f"  ⚙ {name}")
        elif role == "user" and btype == "tool_result":
            typer.echo("    ↳ (tool result received)")


async def _bootstrap_local() -> Any:
    """Init DB + create @local user/project/compute_node. Returns the cn."""
    from flow_sdk.db.database import init_db
    from flow_sdk.server.routes.bootstrap import (
        get_or_create_local_compute_node,
        get_or_create_local_project,
        get_or_create_local_user,
    )
    await init_db()
    user = await get_or_create_local_user()
    project = await get_or_create_local_project(desktop_user=user)
    cn = await get_or_create_local_compute_node(local_project=project, desktop_user=user)
    return cn


def _drive_migration_script(
    version: str,
    script_path: Path,
    status_dir: Path,
    record: MigrationRecord,
) -> int:
    """Execute a ``scripts/migrate.py`` script via importlib.

    Contract:
      * The script module exposes a callable ``run()`` (no args, returns None).
      * Failures raise; the runner converts to status=error + exit 1.
      * The script is responsible for its own idempotency.
      * stdout/stderr are inherited — the script's prints stream live.

    Unlike the agentic path, there is no "warmup" delay: a Python script
    starts producing output immediately, so we go straight from ``started``
    to ``running`` before invoking it.
    """
    running = record.transition(MigrationStatus.RUNNING)
    migration_status.write(status_dir, running)
    typer.echo(f"  Running migration script: {script_path}")

    try:
        # Unique module name per version so re-runs don't hit sys.modules cache.
        mod_name = f"_flowpad_migration_{version.replace('.', '_').replace('-', '_')}"
        spec = importlib.util.spec_from_file_location(mod_name, script_path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"could not load migration script spec from {script_path}")
        module = importlib.util.module_from_spec(spec)
        # Register in sys.modules BEFORE exec_module: dataclasses (and others)
        # resolve type annotations via sys.modules[cls.__module__], and a missing
        # entry raises AttributeError("'NoneType' object has no attribute '__dict__'")
        # when the dataclass decorator runs at module top-level.
        sys.modules[mod_name] = module
        try:
            spec.loader.exec_module(module)
            if not hasattr(module, "run"):
                raise AttributeError(f"{script_path} has no run() entry point")
            module.run()
        finally:
            sys.modules.pop(mod_name, None)
    except (KeyboardInterrupt, asyncio.CancelledError):
        terminal = running.transition(MigrationStatus.ERROR, error_msg="interrupted")
        migration_status.write(status_dir, terminal)
        typer.echo("Migration interrupted.", err=True)
        return 130
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
        terminal = running.transition(MigrationStatus.ERROR, error_msg=err)
        migration_status.write(status_dir, terminal)
        typer.echo(f"ERROR: migration {version}: {err}", err=True)
        return 1

    terminal = running.transition(MigrationStatus.COMPLETED)
    migration_status.write(status_dir, terminal)
    dur = terminal.duration_seconds or 0.0
    typer.echo(f"Migration {version} completed in {dur:.1f}s.")
    return 0


async def _drive_migration(
    version: str,
    recipe_dir: Path,
    status_dir: Path,
    record: MigrationRecord,
    transcript_timeout: float,
) -> int:
    """The actual migration execution — agent spawn, streaming, terminal write.

    Caller owns the filelock. Caller has already written the initial
    ``started`` record. We update it to ``running`` once the agent first
    writes its transcript, then to ``completed``/``error``.
    """
    from flow_sdk.builtin.agentic_process import AgenticProcess

    cn = await _bootstrap_local()

    skill_md = (recipe_dir / "SKILL.md").read_text(encoding="utf-8")
    prompt_text = (
        f"You are running migration {version}. Follow these instructions "
        f"exactly. The recipe directory is mounted at {recipe_dir}; you may "
        f"read any sibling files referenced from the instructions.\n\n"
        f"--- BEGIN RECIPE ---\n{skill_md}\n--- END RECIPE ---"
    )

    ap = AgenticProcess(
        compute_node_id=f"compute_node-{cn.id}",
        cli_config={"permission_mode": "bypassPermissions"},
        workdir=str(Path.cwd()),
        visible=False,
    )
    # Note: NOT calling ap.save([]) — the exist_in_db gate at
    # agentic_process.py:1088-1097 was dropped for visible=False precisely
    # so the migration runner can spawn without a pre-saved record.

    await ap.prompt(prompt_text)

    # Wait up to 15s for Claude to write its first transcript line. The
    # driver pre-assigns ``ap.session_id`` so that alone is unreliable;
    # transcript-file-exists-with-content is the canonical "started"
    # signal (see runner_entrypoint.py:72-87).
    for _ in range(AGENT_WARMUP_TICKS):
        tp = ap.driver.transcript_path(ap)
        if tp and tp.exists() and tp.stat().st_size > 0:
            break
        await asyncio.sleep(AGENT_WARMUP_INTERVAL_S)

    tp = ap.driver.transcript_path(ap)
    if not tp or not tp.exists() or tp.stat().st_size == 0:
        err = "agent never wrote a transcript line within 15s warmup"
        terminal = record.transition(MigrationStatus.ERROR, error_msg=err)
        migration_status.write(status_dir, terminal)
        typer.echo(f"ERROR: migration {version}: {err}", err=True)
        return 1

    # Transition started → running.
    running = record.transition(
        MigrationStatus.RUNNING,
        claude_session_id=ap.session_id,
        ap_id=ap.id,
    )
    migration_status.write(status_dir, running)
    sid = (ap.session_id or "")[:8]
    apid = (ap.id or "")[:8]
    typer.echo(f"  Agent running (session={sid}, ap={apid})")

    # Drain the transcript stream. stream_transcript yields entries in
    # real time (~200ms polling, agentic_process.py:1181-1209), so the
    # user sees output as the agent works.
    try:
        async for entry in ap.stream_transcript(timeout=transcript_timeout):
            _render_entry(entry)
    except (KeyboardInterrupt, asyncio.CancelledError):
        # Propagate up so the outer handler can write the error record.
        raise
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
        terminal = running.transition(MigrationStatus.ERROR, error_msg=err)
        migration_status.write(status_dir, terminal)
        typer.echo(f"ERROR: migration {version}: {err}", err=True)
        return 1

    # Stream complete. Note that iterator-done does NOT prove success —
    # _post_tool_settle can early-exit before ``last-prompt``. For Phase
    # 1 we treat "stream ended without exception" as success; future
    # work could cross-check ``tail_status``.
    terminal = running.transition(MigrationStatus.COMPLETED)
    migration_status.write(status_dir, terminal)
    dur = terminal.duration_seconds or 0.0
    typer.echo(f"Migration {version} completed in {dur:.1f}s.")
    return 0


async def _run_if_needed_async(
    version: str | None,
    transcript_timeout: float,
) -> int:
    if version is None:
        from flow_sdk._version import __version__
        version = __version__

    recipe = _resolve_recipe(version)
    if recipe is None:
        # No recipe — nothing to do for this version. Stays silent so the
        # `flow start` boot path doesn't add noise on every launch.
        return 0

    status_dir = _resolve_status_dir()
    status_dir.mkdir(parents=True, exist_ok=True)

    lock = FileLock(str(migration_status.lock_path(status_dir, version)))
    try:
        lock.acquire(timeout=0)
    except Timeout:
        typer.echo(
            f"Migration {version} already in progress on this machine "
            "(another process holds the lock)."
        )
        return 0

    try:
        existing = migration_status.read(status_dir, version)
        pid_alive = (
            existing is not None
            and _is_process_alive(existing.pid)
        )
        decision = migration_status.decide_action(existing, pid_alive=pid_alive)

        if decision == Decision.SKIP_COMPLETED:
            typer.echo(f"Migration {version} already completed.")
            return 0
        if decision == Decision.SKIP_IN_FLIGHT:
            assert existing is not None
            typer.echo(
                f"Migration {version} already running "
                f"(pid {existing.pid}, started {existing.started_at})."
            )
            return 0

        # decision == Decision.RUN (first run, error retry, or orphan retry).
        if existing is not None and existing.status == MigrationStatus.ERROR.value:
            typer.echo(
                f"Previous attempt at migration {version} errored "
                f"({existing.error_msg!r}); retrying best-effort."
            )
        elif existing is not None:
            typer.echo(
                f"Previous attempt at migration {version} appears orphaned "
                f"(pid {existing.pid} not alive); retrying best-effort."
            )
        else:
            typer.echo(f"Migration {version}: starting.")

        record = MigrationRecord.fresh(version=version, pid=os.getpid())
        migration_status.write(status_dir, record)

        try:
            # Script takes priority when both are present (filesystem prep
            # before agentic work). If we ever want to chain them, this is
            # the place — for now, ship the simpler "one or the other".
            if recipe.script_path is not None:
                return _drive_migration_script(
                    version=version,
                    script_path=recipe.script_path,
                    status_dir=status_dir,
                    record=record,
                )
            assert recipe.skill_dir is not None  # _resolve_recipe guarantees one
            return await _drive_migration(
                version=version,
                recipe_dir=recipe.skill_dir,
                status_dir=status_dir,
                record=record,
                transcript_timeout=transcript_timeout,
            )
        except (KeyboardInterrupt, asyncio.CancelledError):
            terminal = record.transition(
                MigrationStatus.ERROR,
                error_msg="interrupted",
            )
            migration_status.write(status_dir, terminal)
            typer.echo("Migration interrupted.", err=True)
            return 130
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            terminal = record.transition(MigrationStatus.ERROR, error_msg=err)
            migration_status.write(status_dir, terminal)
            typer.echo(f"ERROR: migration {version}: {err}", err=True)
            return 1
    finally:
        try:
            lock.release()
        except Exception:
            pass


def run_if_needed(
    version: str | None = None,
    *,
    transcript_timeout: float = DEFAULT_TRANSCRIPT_TIMEOUT_S,
) -> int:
    """Synchronous entry point usable from CLI / `flow start`.

    If an event loop is already running we cannot call ``asyncio.run``;
    fall back to a thread (precedent: ``flow_sdk/cli/hub_login.py:97-104``).
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_run_if_needed_async(version, transcript_timeout))

    # We're inside a loop already — bounce to a worker thread.
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=1) as pool:
        fut = pool.submit(
            lambda: asyncio.run(_run_if_needed_async(version, transcript_timeout))
        )
        return fut.result()
