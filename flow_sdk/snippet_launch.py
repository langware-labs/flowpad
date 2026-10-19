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


# ── check: what would fail before the file does anything useful ──────────────

#: Names the interpreter puts in a ``__main__`` module before the first line runs.
_MODULE_NAMES = frozenset({"__name__", "__file__", "__doc__", "__builtins__", "__spec__", "__loader__", "__package__", "__annotations__"})


def _diagnostic(node_or_line, message: str, kind: str, *, col: int = 1, end_col: "int | None" = None, end_line: "int | None" = None) -> dict:
    """One problem, 1-based line and column (the editor's convention), end exclusive."""
    if isinstance(node_or_line, ast.AST):
        line, col = node_or_line.lineno, node_or_line.col_offset + 1
        end_line = getattr(node_or_line, "end_lineno", None) or line
        end_col = (getattr(node_or_line, "end_col_offset", None) or node_or_line.col_offset) + 1
    else:
        line = node_or_line
    return {"line": line, "col": col, "end_line": end_line or line, "end_col": end_col or col + 1, "severity": "error", "kind": kind, "message": message}


def _bound_names(tree: ast.AST) -> "set[str] | None":
    """Every name the file binds anywhere — any scope. ``None`` when a star import makes that unknowable.

    Scope-blind on purpose: a name bound in ANY scope is never reported, so the check can miss a
    use-before-bind but never flags a name the file really defines."""
    bound: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bound.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(node.name)
        elif isinstance(node, ast.arg):
            bound.add(node.arg)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                if alias.name == "*":
                    return None
                bound.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bound.add(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            bound.update(node.names)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            bound.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            bound.add(node.rest)
    return bound


def _undefined_names(tree: ast.AST) -> "list[dict]":
    import builtins  # noqa: PLC0415

    bound = _bound_names(tree)
    if bound is None:
        return []
    known = bound | _MODULE_NAMES | set(dir(builtins))
    return [
        _diagnostic(node, f"name '{node.id}' is not defined", "name")
        for node in ast.walk(tree)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in known
    ]


def _unresolved_imports(tree: ast.AST) -> "list[dict]":
    """Each import the file makes that this interpreter cannot satisfy — the ``ModuleNotFoundError``
    or ``ImportError`` the run would stop at, on the line that makes it. Imports the modules to know."""
    import importlib  # noqa: PLC0415
    import importlib.util  # noqa: PLC0415

    def missing(module: str) -> "str | None":
        try:
            return None if importlib.util.find_spec(module) is not None else f"No module named '{module}'"
        except (ImportError, ValueError) as exc:  # a parent package that is itself missing or broken
            return str(exc)
        except Exception as exc:  # noqa: BLE001 — a module that raises on import is a finding, not a crash
            return f"importing '{module}' raises {type(exc).__name__}: {exc}"

    found: list[dict] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if why := missing(alias.name):
                    found.append(_diagnostic(node, why, "import"))
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            if why := missing(node.module):
                found.append(_diagnostic(node, why, "import"))
                continue
            try:
                module = importlib.import_module(node.module)
            except Exception as exc:  # noqa: BLE001 — see `missing`
                found.append(_diagnostic(node, f"importing '{node.module}' raises {type(exc).__name__}: {exc}", "import"))
                continue
            for alias in node.names:
                if alias.name != "*" and not hasattr(module, alias.name) and missing(f"{node.module}.{alias.name}"):
                    found.append(_diagnostic(node, f"cannot import name '{alias.name}' from '{node.module}'", "import"))
    return found


def diagnose(source: str, filename: str = "<snippet>", *, imports: bool = True) -> "list[dict]":
    """What stops *source* before it does its job, top-level ``await`` allowed: a syntax error (then
    nothing else — the rest cannot be read), names nothing binds, and imports this interpreter cannot
    satisfy. Sorted by position; empty when the file is clean."""
    try:
        compile_snippet(source, filename)
    except SyntaxError as exc:
        line = exc.lineno or 1
        col = exc.offset or 1
        end_col = exc.end_offset if exc.end_offset and exc.end_offset > col and (exc.end_lineno or line) == line else col + 1
        return [_diagnostic(line, exc.msg, "syntax", col=col, end_col=end_col)]
    tree = ast.parse(source, filename)
    found = _undefined_names(tree) + (_unresolved_imports(tree) if imports else [])
    return sorted(found, key=lambda d: (d["line"], d["col"]))


def main() -> None:
    if len(sys.argv) >= 3 and sys.argv[1] == "--check":
        import json  # noqa: PLC0415

        with tokenize.open(sys.argv[2]) as f:
            source = f.read()
        sys.path[0] = os.path.dirname(os.path.abspath(sys.argv[2]))  # imports resolve as a run's would
        sys.stdout.write(json.dumps(diagnose(source, os.path.abspath(sys.argv[2]))) + "\n")
        raise SystemExit(0)
    if len(sys.argv) < 2:
        sys.stderr.write("usage: python -m flow_sdk.snippet_launch [--check] <file> [args...]\n")
        raise SystemExit(2)
    raise SystemExit(run_file(sys.argv[1], sys.argv[2:]))


if __name__ == "__main__":
    main()
