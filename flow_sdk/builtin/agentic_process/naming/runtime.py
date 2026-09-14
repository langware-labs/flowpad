"""Shared lifecycle for worker naming; provider adapters only supply observations.

Subscriptions live on the backend, independently of terminal/browser mounts.
Each filesystem directory has one observer per event loop, shared by processes.
"""
from __future__ import annotations

import asyncio
import logging
from contextvars import Context
from pathlib import Path
from weakref import WeakKeyDictionary

_log = logging.getLogger(__name__)
_runtimes: WeakKeyDictionary = WeakKeyDictionary()


def _runtime() -> "NamingRuntime":
    loop = asyncio.get_running_loop()
    runtime = _runtimes.get(loop)
    if runtime is None:
        runtime = NamingRuntime()
        _runtimes[loop] = runtime
    return runtime


def _source_paths(process) -> tuple[Path, ...]:
    return tuple(Path(p).absolute() for p in process.driver.naming_adapter.watch_paths(process))


def _watch_directory(path: Path) -> Path | None:
    directory = path if path.is_dir() else path.parent
    while not directory.is_dir() and directory != directory.parent:
        directory = directory.parent
    # Never accidentally watch the entire machine for a nonexistent source.
    return directory if directory.is_dir() and directory != directory.parent else None


class NamingRuntime:
    def __init__(self) -> None:
        self.bindings: dict[str, tuple[Path, ...]] = {}
        self.watchers: dict[Path, asyncio.Task] = {}
        self.refreshes: dict[str, asyncio.Task] = {}
        self.dirty: set[str] = set()

    def bind(self, process, paths: tuple[Path, ...]) -> None:
        self.bindings[str(process.id)] = paths
        wanted = self._prune_watchers()
        for directory in wanted - set(self.watchers):
            self.watchers[directory] = Context().run(asyncio.create_task, self._watch(directory), name="worker-name-watch")

    def request_refresh(self, process_id: str) -> None:
        process_id = str(process_id)
        self.dirty.add(process_id)
        if process_id not in self.refreshes:
            self.refreshes[process_id] = Context().run(
                asyncio.create_task, self._drain(process_id), name="worker-name-refresh")

    def unbind(self, process_id: str) -> None:
        self.bindings.pop(str(process_id), None)
        self.dirty.discard(str(process_id))
        self._prune_watchers()

    def _prune_watchers(self) -> set[Path]:
        wanted = {d for sources in self.bindings.values() for p in sources if (d := _watch_directory(p))}
        for directory in set(self.watchers) - wanted:
            self.watchers.pop(directory).cancel()
        return wanted

    async def _watch(self, directory: Path) -> None:
        from watchfiles import awatch

        try:
            async for changes in awatch(directory, watch_filter=None):
                changed = tuple(Path(p).absolute() for _, p in changes)
                for process_id, sources in tuple(self.bindings.items()):
                    if any(p == source or source in p.parents for p in changed for source in sources):
                        self.request_refresh(process_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            _log.exception("worker naming observation failed for %s", directory)
        finally:
            if self.watchers.get(directory) is asyncio.current_task():
                self.watchers.pop(directory, None)

    async def _drain(self, process_id: str) -> None:
        from flow_sdk.builtin.agentic_process import AgenticProcess

        try:
            while process_id in self.dirty:
                self.dirty.discard(process_id)
                process = await AgenticProcess.get_by_id(process_id)
                if process is None:
                    self.unbind(process_id)
                    return
                await refresh_process_name(process)
        except asyncio.CancelledError:
            raise
        except Exception:
            _log.exception("worker naming refresh failed for %s", process_id)
        finally:
            if self.refreshes.get(process_id) is asyncio.current_task():
                self.refreshes.pop(process_id, None)


async def refresh_process_name(process, *, first_prompt: str | None = None, watch: bool = True):
    """Bind/read/reconcile one process. Missing observations retain its last name."""
    from .service import reconcile_name

    if process.hub_route:
        return process
    migration = ()
    driver = process._restart_driver()
    if driver is not None and (process.naming_state is None or process.naming_state.session_id != process.session_id):
        migration = await asyncio.to_thread(driver.naming_adapter.read, process)
    result = await reconcile_name(str(process.id), first_prompt=first_prompt,
                                  migration_observations=migration)
    current = result.process
    if current is None:
        return None
    driver = current._restart_driver()
    if driver is None:
        return current
    adapter = driver.naming_adapter
    if not current.session_id:
        # PTY harnesses mint their native identity after launch. Reuse the
        # driver's bounded discovery rather than waiting for a transcript view.
        descriptor = await asyncio.to_thread(lambda: current.transcript)
        if descriptor is not None and descriptor.session_id:
            await current._persist_transcript_session_id(descriptor)
            if current.session_id:
                return await refresh_process_name(current, first_prompt=first_prompt, watch=watch)
    if watch:
        from flow_sdk.builtin.process_lifecycle import ProcessStatus

        if current.status not in (ProcessStatus.STOPPED, ProcessStatus.STOPPING, ProcessStatus.FAILED):
            paths = await asyncio.to_thread(_source_paths, current)
            _runtime().bind(current, paths)
    # Read after subscribing: changes during the initial read are observed too.
    if current.session_id and not first_prompt and not current.naming_state.fallback:
        from flow_sdk.builtin.worker_history import _normalize_worker_type, _worker_first_prompt_sync

        def initial_prompt():
            path = current.transcript_path
            return _worker_first_prompt_sync(_normalize_worker_type(current.worker_type), path) if path else None

        prompt = await asyncio.to_thread(initial_prompt)
        if prompt:
            result = await reconcile_name(str(current.id), first_prompt=prompt)
            current = result.process
            if current is None:
                return None
    try:
        observations = await asyncio.to_thread(adapter.read, current)
    except (OSError, ValueError):
        _log.debug("worker name unavailable for %s", current.id, exc_info=True)
        return current
    for observation in observations:
        result = await reconcile_name(str(current.id), observation=observation)
        current = result.process
        if current is None:
            return None
    return current


async def observe_terminal_title(process, title: str, session_id: str | None):
    from .service import reconcile_name

    if process.session_id != session_id:
        return process
    driver = process._restart_driver()
    if driver is None:
        return process
    observation = await asyncio.to_thread(driver.naming_adapter.terminal_observation, process, title)
    if observation is None:
        return process
    return (await reconcile_name(str(process.id), observation=observation)).process


def request_name_refresh(process_id: str) -> None:
    """Coalesce transcript edges without blocking transcript delivery on name I/O."""
    _runtime().request_refresh(str(process_id))


def stop_name_observation(process_id: str) -> None:
    runtime = _runtime()
    runtime.unbind(str(process_id))
    task = runtime.refreshes.pop(str(process_id), None)
    if task is not None:
        task.cancel()


async def restore_name_observation() -> None:
    """Restore backend subscriptions without requiring a mounted terminal."""
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.process_lifecycle import ProcessStatus

    for process in await AgenticProcess.get_all():
        if process.status in (ProcessStatus.STOPPED, ProcessStatus.STOPPING, ProcessStatus.FAILED):
            continue
        try:
            await refresh_process_name(process)
        except Exception:
            _log.exception("worker naming restore failed for %s", process.id)


async def shutdown_name_observation() -> None:
    runtime = _runtimes.pop(asyncio.get_running_loop(), None)
    if runtime is None:
        return
    tasks = [*runtime.watchers.values(), *runtime.refreshes.values()]
    runtime.bindings.clear()
    runtime.dirty.clear()
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
