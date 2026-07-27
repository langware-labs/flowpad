"""Shared fake-CLI scaffolding for the print-mode stream-worker tests.

The workers spawn a real subprocess via ``_build_spawn``; these helpers replace
that seam with a cheap ``bash -c`` script that ``printf``s canned stream-json
lines, so the tests exercise the genuine subprocess/pipe/converter path without
touching a real ``claude`` / ``copilot`` / ``codex`` binary.
"""

from __future__ import annotations

import json


def fake_stream_argv(lines: list[dict], delay_ms: int = 0) -> list[str]:
    """A ``bash -c`` argv that emits each dict in *lines* as one stream-json
    line, optionally sleeping ``delay_ms`` ms between lines."""
    pieces: list[str] = []
    for obj in lines:
        pieces.append(f"printf '%s\\n' {json.dumps(json.dumps(obj))}")
        if delay_ms > 0:
            pieces.append(f"sleep {delay_ms / 1000:.3f}")
    return ["bash", "-c", "; ".join(pieces)]


def patch_build_spawn(monkeypatch, worker_cls, argv, env=None, stdin=None):
    """Monkeypatch ``worker_cls._build_spawn`` to return a fixed spawn tuple.

    Always returns the 3-tuple ``(argv, env, stdin)`` every worker unpacks.
    ``stdin=None`` means "no stdin payload" (the child gets DEVNULL); a string
    is written to the child's stdin pipe (all three vendors deliver the prompt
    over stdin). The stub ignores the differently-ordered ``prompt``/``context``
    positionals the worker families pass.
    """
    spawn = (argv, env or {}, stdin)

    def _stub(self, *args, **kwargs):  # noqa: ANN001
        return spawn

    monkeypatch.setattr(worker_cls, "_build_spawn", _stub, raising=True)
    return spawn


def seed_harness_capability(monkeypatch, worker_type: str, bin_dir) -> None:
    """Inject a discovered ``harness.<worker>.cli`` capability value (the CLI's
    bin FOLDER) into the discovery store, restored on test teardown."""
    from flow_sdk.core.capabilities import discovery
    from flow_sdk.core.capabilities.models import CapabilityValue

    kind = f"harness.{worker_type}.cli"
    monkeypatch.setitem(
        discovery._VALUES,
        kind,
        CapabilityValue(kind=kind, value={"path": str(bin_dir)}, value_type="folder"),
    )


def clear_harness_capability(monkeypatch, worker_type: str) -> None:
    """Remove any discovered ``harness.<worker>.cli`` value (CLI not installed)."""
    from flow_sdk.core.capabilities import discovery

    monkeypatch.delitem(discovery._VALUES, f"harness.{worker_type}.cli", raising=False)


def make_fake_cli_bin(tmp_path, name: str):
    """Create ``<tmp_path>/nvm-bin/<name>`` as an executable stub; returns
    ``(bin_dir, exe_path)`` — the shape capability discovery records for a CLI
    that lives outside the backend's service PATH (e.g. under nvm)."""
    bin_dir = tmp_path / "nvm-bin"
    bin_dir.mkdir(exist_ok=True)
    exe = bin_dir / name
    exe.write_text("#!/bin/sh\n", encoding="utf-8")
    exe.chmod(0o755)
    return bin_dir, exe
