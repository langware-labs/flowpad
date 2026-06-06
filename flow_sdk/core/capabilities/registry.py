from __future__ import annotations

import asyncio
import shutil
import subprocess
from abc import ABC, abstractmethod
from typing import Any

from flow_sdk.core.capabilities.models import (
    CapabilityCheck,
    CapabilityKind,
    CapabilityResult,
    CapabilitySpec,
    capability_kind_matches,
)


class CapabilityRunner(ABC):
    spec: CapabilitySpec

    @abstractmethod
    async def check(self) -> CapabilityResult:
        ...

    async def install(self) -> CapabilityResult:
        """Default install: start the capability's install agentic process.

        The browser needs the process id while the worker is still running, so
        install starts the prompt and returns immediately. A background monitor
        refreshes the capability row after the worker reaches a terminal state.
        """
        return await run_capability_install_process(self.spec)

    @abstractmethod
    async def test(self) -> CapabilityResult:
        ...


class CliCapabilityRunner(CapabilityRunner):
    def __init__(
        self,
        *,
        spec: CapabilitySpec,
        executable: str,
        test_args: list[str] | None = None,
        timeout_seconds: float = 5.0,
    ) -> None:
        self.spec = spec
        self.executable = executable
        self.test_args = test_args or ["--version"]
        self.timeout_seconds = timeout_seconds

    def _resolve(self) -> str | None:
        return shutil.which(self.executable)

    def _not_found_result(self) -> CapabilityResult:
        return CapabilityResult(
            ok=False,
            available=False,
            message=f"{self.executable} CLI was not found in PATH.",
            details={"executable": self.executable},
        )

    async def check(self) -> CapabilityResult:
        path = self._resolve()
        if not path:
            return self._not_found_result()
        return CapabilityResult(
            ok=True,
            available=True,
            message=f"{self.executable} CLI is available.",
            details={"executable": self.executable, "path": path},
        )

    async def test(self) -> CapabilityResult:
        path = self._resolve()
        if not path:
            return self._not_found_result()
        try:
            proc = await asyncio.to_thread(
                subprocess.run,
                [path, *self.test_args],
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
            )
        except subprocess.TimeoutExpired:
            return CapabilityResult(
                ok=False,
                available=True,
                message=f"{self.executable} CLI test timed out.",
                details={"executable": self.executable, "path": path, "timeout_seconds": self.timeout_seconds},
            )
        except Exception as exc:
            return CapabilityResult(
                ok=False,
                available=True,
                message=f"{self.executable} CLI test failed: {exc}",
                details={"executable": self.executable, "path": path},
            )
        output = (proc.stdout or proc.stderr or "").strip()
        return CapabilityResult(
            ok=proc.returncode == 0,
            available=True,
            message=f"{self.executable} CLI test {'passed' if proc.returncode == 0 else 'failed'}.",
            details={
                "executable": self.executable,
                "path": path,
                "returncode": proc.returncode,
                "output": output[:1000],
            },
        )


class CapabilityReferenceRunner(CapabilityRunner):
    """A capability that is a pointer to another capability.

    The live target is the entity row's ``reference_kind`` (falling back to
    the spec's seed default). check/install/test resolve the referenced kind
    in turn via the registry, and stamp ``details.reference_kind`` so callers
    learn which concrete capability the reference resolved to. References may
    not chain (a reference pointing at another reference fails fast).
    """

    def __init__(self, *, spec: CapabilitySpec, allowed_query: str) -> None:
        self.spec = spec
        # Ontological constraint for valid targets, e.g. "harness" → harness.*
        self.allowed_query = allowed_query

    async def _resolve_reference_kind(self) -> str | None:
        from flow_sdk.builtin.capability import Capability

        capability = await Capability.get_by_kind(self.spec.kind)
        reference = (capability.reference_kind if capability else None) or self.spec.reference_kind
        return reference.strip().lower() if reference else None

    def _target_failure(self, reference: str | None) -> CapabilityResult | None:
        """Validate the reference target; return a failure result or None when valid."""
        if not reference:
            return CapabilityResult(
                ok=False,
                available=False,
                message=f"No capability referenced — set reference_kind to a {self.allowed_query}.* capability.",
                details={"allowed_query": self.allowed_query},
            )
        if reference == self.spec.kind or not capability_kind_matches(self.allowed_query, reference):
            return CapabilityResult(
                ok=False,
                available=False,
                message=f"Invalid reference {reference!r} — must be a {self.allowed_query}.* capability.",
                details={"reference_kind": reference, "allowed_query": self.allowed_query},
            )
        try:
            target_runner = get_capability_registry().get(reference)
        except KeyError:
            return CapabilityResult(
                ok=False,
                available=False,
                message=f"Referenced capability {reference!r} is not registered.",
                details={"reference_kind": reference},
            )
        if isinstance(target_runner, CapabilityReferenceRunner):
            return CapabilityResult(
                ok=False,
                available=False,
                message=f"Reference {reference!r} points at another reference — chains are not supported.",
                details={"reference_kind": reference},
            )
        return None

    async def _delegate(self, action: str) -> CapabilityResult:
        reference = await self._resolve_reference_kind()
        failure = self._target_failure(reference)
        if failure is not None:
            return failure
        check: CapabilityCheck = await getattr(get_capability_registry(), action)(reference)
        result = check.result
        return result.model_copy(update={"details": {**result.details, "reference_kind": reference}})

    async def check(self) -> CapabilityResult:
        return await self._delegate("check")

    async def install(self) -> CapabilityResult:
        return await self._delegate("install")

    async def test(self) -> CapabilityResult:
        return await self._delegate("test")


class ChromeAuthenticatedBrowsingRunner(CapabilityRunner):
    def __init__(self, spec: CapabilitySpec) -> None:
        self.spec = spec

    async def check(self) -> CapabilityResult:
        from flow_sdk.builtin.capability import Capability

        capability = await Capability.get_by_kind(self.spec.kind)
        latest = capability.last_test if capability else None
        if isinstance(latest, dict) and latest.get("ok") and latest.get("available"):
            return CapabilityResult(
                ok=True,
                available=True,
                message="Authenticated Chrome browsing probe has passed.",
                details={"last_test": latest},
                process_id=latest.get("process_id"),
            )
        return CapabilityResult(
            ok=False,
            available=False,
            message="Run the authenticated Chrome browsing test to validate this capability.",
            details={},
        )

    async def test(self) -> CapabilityResult:
        return await run_chrome_authenticated_probe()


# Placeholder install prompt — proves the install→agentic-process wiring.
DEFAULT_INSTALL_PROMPT = "count till 10"
_INSTALL_MONITOR_TASKS: set[asyncio.Task] = set()


async def resolve_default_harness_kind() -> str:
    """Resolve the user-selected default harness capability to a concrete leaf."""
    check = await get_capability_registry().check(CapabilityKind.HARNESS.value)
    reference = check.result.details.get("reference_kind")
    if not check.result.available or not isinstance(reference, str):
        raise RuntimeError(f"Default harness is not available: {check.result.message}")
    return reference


def build_install_worker_config(harness_kind: str) -> tuple[str, dict[str, Any]]:
    """Return AgenticProcess worker_type + cli_config for a harness leaf kind."""
    if harness_kind == CapabilityKind.CLAUDE_CLI.value:
        from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeCliOptions
        from flow_sdk.flowpad_types.enums import WorkerType

        return WorkerType.CLAUDE_CODE.value, ClaudeCliOptions(permission_mode="bypassPermissions").to_json()
    if harness_kind == CapabilityKind.CODEX_CLI.value:
        from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexCliOptions
        from flow_sdk.flowpad_types.enums import WorkerType

        return WorkerType.CODEX.value, CodexCliOptions(permission_mode="bypassPermissions").to_json()
    raise RuntimeError(f"Unsupported install harness kind: {harness_kind}")


def _schedule_install_monitor(process_id: str, kind: str) -> None:
    task = asyncio.create_task(
        _monitor_capability_install_process(process_id, kind),
        name=f"capability-install-{kind}:{process_id[:8]}",
    )
    _INSTALL_MONITOR_TASKS.add(task)
    task.add_done_callback(_INSTALL_MONITOR_TASKS.discard)


async def _monitor_capability_install_process(process_id: str, kind: str) -> None:
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.capability import Capability

    capability = await Capability.get_by_kind(kind)
    try:
        process = await AgenticProcess.get_by_id(process_id)
        if process is None:
            raise RuntimeError(f"Install process {process_id} was not found.")
        await process.wait()
        check = await get_capability_registry().check(kind)
        if capability is None:
            return
        capability.last_check = check.result.model_dump(mode="json")
        started = capability.last_install if isinstance(capability.last_install, dict) else {}
        started_details = started.get("details") if isinstance(started.get("details"), dict) else {}
        capability.last_install = CapabilityResult(
            ok=bool(started.get("ok", True)) and check.result.ok,
            available=check.result.available,
            message=f"{started.get('message') or 'Install process completed.'} {check.result.message}",
            details={**started_details, **check.result.details},
            process_id=process_id,
        ).model_dump(mode="json")
        await capability.save(notify=True)
    except Exception as exc:
        if capability is None:
            return
        started = capability.last_install if isinstance(capability.last_install, dict) else {}
        started_details = started.get("details") if isinstance(started.get("details"), dict) else {}
        capability.last_install = CapabilityResult(
            ok=False,
            available=False,
            message=f"Install process failed: {exc}",
            details={**started_details, "error": str(exc)},
            process_id=process_id,
        ).model_dump(mode="json")
        await capability.save(notify=True)


async def run_capability_install_process(spec: CapabilitySpec) -> CapabilityResult:
    """Start a capability's install as a headless agentic process.

    The worker runs the spec's ``install_prompt`` (or
    ``DEFAULT_INSTALL_PROMPT``) using the default harness selected by the
    ``harness`` capability. The result carries ``process_id`` immediately so UI
    surfaces can show/open the run while it is still active.
    """
    from pathlib import Path

    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.capability import capability_id_for_kind
    from flow_sdk.instance_settings import get_instance_settings
    from flow_sdk.responses.response import ApiFailResponse

    prompt = spec.install_prompt or DEFAULT_INSTALL_PROMPT
    workdir = Path(get_instance_settings().flow_home) / "capability-installs"
    workdir.mkdir(parents=True, exist_ok=True)

    try:
        harness_kind = await resolve_default_harness_kind()
        worker_type, cli_config = build_install_worker_config(harness_kind)
    except Exception as exc:
        return CapabilityResult(
            ok=False,
            available=False,
            message=f"Install process could not start: {exc}",
            details={"prompt": prompt},
        )

    target_typeid_str = f"capability-{capability_id_for_kind(spec.kind)}"
    process = AgenticProcess(
        name=f"Install {spec.name}",
        workdir=str(workdir),
        visible=False,
        worker_type=worker_type,
        cli_config=cli_config,
        context_data={
            "capability_kind": spec.kind,
            "install_prompt": prompt,
            "install_harness_kind": harness_kind,
        },
        target_typeid_str=target_typeid_str,
    )
    await process.save(notify=True)
    try:
        start_result = await process.prompt(prompt)
    except Exception as exc:
        return CapabilityResult(
            ok=False,
            available=False,
            message=f"Install process failed: {exc}",
            details={"prompt": prompt},
            process_id=process.id,
        )
    if isinstance(start_result, ApiFailResponse):
        return CapabilityResult(
            ok=False,
            available=False,
            message=f"Install process failed to start: {start_result.message}",
            details={"prompt": prompt, "harness_kind": harness_kind, "worker_type": worker_type},
            process_id=process.id,
        )

    _schedule_install_monitor(process.id, spec.kind)
    return CapabilityResult(
        ok=True,
        available=False,
        message="Install process started.",
        details={
            "prompt": prompt,
            "harness_kind": harness_kind,
            "worker_type": worker_type,
            "start": start_result.data or {},
        },
        process_id=process.id,
    )


async def run_chrome_authenticated_probe() -> CapabilityResult:
    import secrets
    from pathlib import Path

    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeCliOptions
    from flow_sdk.builtin.capability import capability_id_for_kind
    from flow_sdk.instance_settings import get_instance_settings

    nonce = f"flowpad-capability-{secrets.token_hex(8)}"
    probe_dir = Path(get_instance_settings().flow_home) / "capability-probes"
    probe_dir.mkdir(parents=True, exist_ok=True)
    probe_file = probe_dir / "chrome-authenticated-probe.html"
    probe_file.write_text(
        "<!doctype html><html><body>"
        f"<main id=\"flowpad-capability-probe\">{nonce}</main>"
        "</body></html>",
        encoding="utf-8",
    )

    cli_options = ClaudeCliOptions(
        chrome=True,
        permission_mode="bypassPermissions",
    )
    target_typeid_str = f"capability-{capability_id_for_kind(CapabilityKind.CHROME_AUTHENTICATED.value)}"
    process = AgenticProcess(
        name="Chrome authenticated browsing capability probe",
        workdir=str(probe_dir),
        visible=False,
        cli_config=cli_options.to_json(),
        context_data={
            "capability_kind": CapabilityKind.CHROME_AUTHENTICATED.value,
            "probe_url": probe_file.as_uri(),
            "expected_value": nonce,
        },
        target_typeid_str=target_typeid_str,
    )
    await process.save(notify=True)
    prompt = (
        "Use Chrome browsing to open this URL and read the exact text inside "
        f"#flowpad-capability-probe: {probe_file.as_uri()}\n"
        f"Return only the exact text. Expected value: {nonce}"
    )
    try:
        result = await AgenticProcess.run(
            prompt,
            id=process.id,
            name=process.name,
            workdir=str(probe_dir),
            cli_config=cli_options.to_json(),
            context_data=process.context_data,
            target_typeid_str=target_typeid_str,
            visible=False,
        )
    except Exception as exc:
        return CapabilityResult(
            ok=False,
            available=False,
            message=f"Authenticated Chrome browsing probe failed: {exc}",
            details={"expected": nonce, "probe_url": probe_file.as_uri()},
            process_id=process.id,
        )
    text = (result.text or "").strip()
    ok = nonce in text
    return CapabilityResult(
        ok=ok,
        available=ok,
        message="Authenticated Chrome browsing probe passed." if ok else "Authenticated Chrome browsing probe returned the wrong value.",
        details={
            "expected": nonce,
            "actual": text[:1000],
            "probe_url": probe_file.as_uri(),
            "session_id": result.session_id,
        },
        process_id=process.id,
    )


def get_default_capability_specs() -> list[CapabilitySpec]:
    return [
        CapabilitySpec(
            name="Default harness",
            kind=CapabilityKind.HARNESS.value,
            description="The harness used by default. References a concrete harness capability.",
            icon="Link",
            reference_kind=CapabilityKind.CLAUDE_CLI.value,
        ),
        CapabilitySpec(
            name="Claude CLI",
            kind=CapabilityKind.CLAUDE_CLI.value,
            description="Claude Code command-line harness.",
            icon="Bot",
        ),
        CapabilitySpec(
            name="Codex CLI",
            kind=CapabilityKind.CODEX_CLI.value,
            description="Codex command-line harness.",
            icon="Terminal",
        ),
        CapabilitySpec(
            name="Chrome Authenticated Browsing",
            kind=CapabilityKind.CHROME_AUTHENTICATED.value,
            description="Agent-driven Chrome browsing with authenticated browser state.",
            icon="Globe",
            dependent_capability_kinds=[CapabilityKind.CLAUDE_CLI.value],
        ),
    ]


class CapabilityRegistry:
    def __init__(self) -> None:
        self._runners: dict[str, CapabilityRunner] = {}

    def register(self, runner: CapabilityRunner) -> None:
        self._runners[runner.spec.kind] = runner

    def get(self, kind: str) -> CapabilityRunner:
        try:
            return self._runners[kind]
        except KeyError as exc:
            raise KeyError(f"Unknown capability kind: {kind}") from exc

    def specs(self) -> list[CapabilitySpec]:
        return [runner.spec for runner in self._runners.values()]

    def matching_specs(self, query_kind: str) -> list[CapabilitySpec]:
        return [runner.spec for runner in self._runners.values() if runner.spec.matches(query_kind)]

    async def check(self, kind: str, *, include_dependencies: bool = True) -> CapabilityCheck:
        runner = self.get(kind)
        dependencies: dict[str, CapabilityResult] = {}
        if include_dependencies:
            for dep_kind in runner.spec.dependent_capability_kinds:
                dependencies[dep_kind] = (await self.check(dep_kind, include_dependencies=True)).result
        blocked = [k for k, result in dependencies.items() if not result.available]
        if blocked:
            return CapabilityCheck(
                kind=kind,
                result=CapabilityResult(
                    ok=False,
                    available=False,
                    message=f"Missing dependent capabilities: {', '.join(blocked)}",
                    details={"missing_dependencies": blocked},
                ),
                dependencies=dependencies,
            )
        return CapabilityCheck(kind=kind, result=await runner.check(), dependencies=dependencies)

    async def install(self, kind: str) -> CapabilityCheck:
        runner = self.get(kind)
        return CapabilityCheck(kind=kind, result=await runner.install())

    async def test(self, kind: str) -> CapabilityCheck:
        dependency_check = await self.check(kind, include_dependencies=True)
        if not dependency_check.result.available and dependency_check.result.details.get("missing_dependencies"):
            return dependency_check
        runner = self.get(kind)
        return CapabilityCheck(kind=kind, result=await runner.test(), dependencies=dependency_check.dependencies)


def _build_default_registry() -> CapabilityRegistry:
    registry = CapabilityRegistry()
    specs = {spec.kind: spec for spec in get_default_capability_specs()}
    registry.register(
        CapabilityReferenceRunner(
            spec=specs[CapabilityKind.HARNESS.value],
            allowed_query=CapabilityKind.HARNESS.value,
        )
    )
    registry.register(
        CliCapabilityRunner(
            spec=specs[CapabilityKind.CLAUDE_CLI.value],
            executable="claude",
        )
    )
    registry.register(
        CliCapabilityRunner(
            spec=specs[CapabilityKind.CODEX_CLI.value],
            executable="codex",
        )
    )
    registry.register(ChromeAuthenticatedBrowsingRunner(specs[CapabilityKind.CHROME_AUTHENTICATED.value]))
    return registry


_DEFAULT_REGISTRY = _build_default_registry()


def get_capability_registry() -> CapabilityRegistry:
    return _DEFAULT_REGISTRY
