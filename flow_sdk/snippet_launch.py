"""Run a python snippet file as written — top-level ``await`` allowed.

Every SDK snippet reads like the asyncio REPL (``async with workflow(...)`` at the top level), and
plain ``python file.py`` refuses that before the first line runs. This launcher is what the snippet
runner starts instead: ``python -m flow_sdk.snippet_launch <file> [args...]``.

The file runs as ``__main__`` with its own path as ``__file__`` and its own folder first on
``sys.path``, exactly as ``python file.py`` would. When the file awaits at its top level the whole
module body runs inside ``asyncio.run``; a file that never awaits runs synchronously, unchanged.
A traceback shows the file's frames only, at the file's own line numbers.

Deliberately stdlib-only and outside ``flow_sdk.core``: that package imports the DB layer (~0.3s),
and a hello-world snippet should not pay for it.
"""

from __future__ import annotations

import ast
import asyncio
import inspect
import os
import sys
import tokenize
import traceback
import types


def compile_snippet(source: str, filename: str = "<snippet>"):
    """*source* as a code object that may ``await`` at its top level. Evaluating it returns a
    coroutine when it does (run that to run the file), and ``None`` when it does not."""
    return compile(source, filename, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)


def _own_frames(tb: "types.TracebackType | None", filename: str) -> "types.TracebackType | None":
    """The traceback from the file's first frame on — the launcher's own frames are not the user's."""
    while tb is not None and tb.tb_frame.f_code.co_filename != filename:
        tb = tb.tb_next
    return tb


def run_file(path: str, argv: "list[str] | None" = None) -> int:
    """Run *path* as ``__main__``; the exit status ``python path`` would have."""
    path = os.path.abspath(path)
    with tokenize.open(path) as f:  # honours a PEP 263 coding line, like the interpreter
        source = f.read()
    try:
        code = compile_snippet(source, path)
    except SyntaxError:
        traceback.print_exc(limit=0)
        return 1
    module = types.ModuleType("__main__")
    module.__file__ = path
    module.__builtins__ = __builtins__  # type: ignore[attr-defined]
    sys.modules["__main__"] = module  # pickle, dataclasses and `if __name__` resolve to the file
    sys.argv = [path, *(argv or [])]
    sys.path[0] = os.path.dirname(path)
    try:
        result = eval(code, module.__dict__)  # noqa: S307 — the user's own file, run on request
        if inspect.isawaitable(result):
            asyncio.run(result)
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001 — reported the way the interpreter would
        traceback.print_exception(type(exc), exc, _own_frames(exc.__traceback__, path))
        return 130 if isinstance(exc, KeyboardInterrupt) else 1
    return 0


def main() -> None:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: python -m flow_sdk.snippet_launch <file> [args...]\n")
        raise SystemExit(2)
    raise SystemExit(run_file(sys.argv[1], sys.argv[2:]))


if __name__ == "__main__":
    main()
