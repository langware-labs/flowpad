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

    Returns a 2-tuple ``(argv, env)`` when *stdin* is ``None`` (claude's shape)
    or a 3-tuple ``(argv, env, stdin)`` otherwise (copilot/codex deliver the
    prompt over the child's stdin). The stub ignores the differently-ordered
    ``prompt``/``context`` positionals the two worker families pass.
    """
    spawn = (argv, env or {}) if stdin is None else (argv, env or {}, stdin)

    def _stub(self, *args, **kwargs):  # noqa: ANN001
        return spawn

    monkeypatch.setattr(worker_cls, "_build_spawn", _stub, raising=True)
    return spawn
