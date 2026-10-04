"""Flow CLI package."""

# `flow_cli` is imported lazily, inside `cli_main`. Importing it here pulled the
# whole CLI — flow_cli -> journey -> graph_workflow_manager -> capabilities,
# ~210ms — into EVERY importer of anything under `flow_sdk.cli`, including
# `server/app.py` reading two config values and three `instance_settings`
# modules reading `app_config`. The console-script entry point
# (`flow = "flow_sdk.cli:cli_main"`) resolves the attribute at call time, so
# only the people who never wanted the CLI stop paying for it.
#
# INTERIM, not the fix: the real problem is that `flow_sdk.cli` is also the
# app's config/auth store (`config_manager`, `app_config`, `auth/`), so ~60
# non-CLI runtime sites import through this package and several already carry
# hand-written `# noqa: PLC0415` cycle-dodges. Moving that content to a neutral
# leaf would let this package import `flow_cli` eagerly again.

__all__ = ["cli_main", "utf8_stdio"]


def utf8_stdio() -> None:
    """Make a redirected stdout/stderr UTF-8, so no CLI output can crash on a character.

    Windows hands a stream that is not a console the ANSI code page (cp1252), and
    the first character outside it raised: ``flow connect`` died printing its own
    enrollment code (the QR's block glyphs) whenever its output was piped,
    redirected, scripted or sent over ssh. A console already speaks Unicode and is
    left alone; ``errors="replace"`` keeps a reader that is not UTF-8 from failing.
    """
    import sys

    for stream in (sys.stdout, sys.stderr):
        if stream is None or stream.isatty():
            continue
        if (getattr(stream, "encoding", "") or "").lower().replace("-", "") == "utf8":
            continue
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def cli_main() -> None:
    """Entry point for the installed ``flow`` console script.

    Boot progress first, the CLI second. `flow start` under the desktop app is
    a startup stage of its own — the CLI import, then migrations, then the
    monitor spawn — and the app's startup gate reads this process's stdout for
    evidence that the stage is still moving. The CLI import is the slow part on
    a weak machine, so the reporter starts before that import, not inside it.
    Off unless the launcher asked (FLOWPAD_BOOT_PROGRESS=1): a terminal user
    sees no extra lines.
    """
    import sys

    utf8_stdio()

    from flow_sdk.boot_progress import start_if_requested

    start_if_requested(sys.stdout)

    from .flow_cli import cli_main as _cli_main

    _cli_main()
