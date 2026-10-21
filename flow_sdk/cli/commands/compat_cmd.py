"""`flow compat` -- is THIS backend compatible with a given desktop app version?

The desktop <-> backend contract lives in ``flow_sdk/utils/compat.py``: the
backend declares the oldest desktop it supports (``flow_sdk/compat.json``,
``min_desktop_version``), the desktop declares the oldest backend it accepts
(``electron/engine-compat.json``, ``min_backend_version``). Both directions
must hold; this command checks them for the backend it runs FROM — run it via
a staged install's own ``flow`` (or its venv's python) to interrogate a
release before activating it, without starting the app.

    flow compat --desktop-version 0.2.45
    flow compat --desktop-version 0.2.45 --desktop-min-backend 0.2.50 --json

Exit codes: 0 compatible, 1 incompatible or indeterminate (broken metadata).
No server, no network, no heavy imports.
"""

from __future__ import annotations

from typing import Optional

import typer
from typing_extensions import Annotated


def compat_check(
    desktop_version: Annotated[str, typer.Option(
        "--desktop-version", help="The desktop app version to validate against this backend."
    )],
    desktop_min_backend: Annotated[Optional[str], typer.Option(
        "--desktop-min-backend",
        help="The desktop's own minimum backend version (electron/engine-compat.json), "
             "to check the other direction too.",
    )] = None,
    json_out: Annotated[bool, typer.Option("--json", help="Machine-readable verdict on stdout.")] = False,
) -> None:
    """Check desktop <-> backend version compatibility for this installed backend."""
    from flow_sdk import __version__  # noqa: PLC0415
    from flow_sdk.cli.commands._common import fail, ok  # noqa: PLC0415
    from flow_sdk.utils import compat  # noqa: PLC0415

    try:
        min_desktop = compat.backend_min_desktop_version()
    except compat.CompatError as exc:
        if json_out:
            fail(1, "INVALID_COMPAT_METADATA", str(exc))
        typer.echo(f"Invalid compatibility metadata: {exc}", err=True)
        raise typer.Exit(1) from exc

    verdict = compat.check_pair(
        desktop_version=desktop_version,
        backend_version=__version__,
        min_desktop_version=min_desktop,
        min_backend_version=desktop_min_backend,
    )
    if json_out:
        ok({
            "compatible": verdict.compatible,
            "backend_version": __version__,
            "desktop_version": desktop_version,
            "min_desktop_version": min_desktop,
            "min_backend_version": desktop_min_backend,
            "reasons": verdict.reasons,
        })
    elif verdict.compatible:
        typer.echo(f"Compatible: backend {__version__} <-> desktop {desktop_version}.")
    else:
        for reason in verdict.reasons:
            typer.echo(reason, err=True)
    raise typer.Exit(0 if verdict.compatible else 1)
