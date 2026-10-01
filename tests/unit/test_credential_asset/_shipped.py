"""Where the shipped credential templates are.

A credential one driver owns lives in that driver's folder (``data_driver/<d>/agentic-assets/credential/<name>``,
the self-contained rule); one no single driver owns stays at the top (``credential/<name>``). Both are shipped
templates, so a test that means "every shipped credential" walks both.
"""
from __future__ import annotations

from pathlib import Path

SHIPPED_PROJECT = Path(__file__).resolve().parents[3] / "flow_sdk/system_projects/flowpad_assistant/agentic-assets"


def shipped_credential_folders() -> dict[str, Path]:
    """``{name: folder}`` of every shipped credential template."""
    folders = [*SHIPPED_PROJECT.glob("credential/*/credential.json"),
               *SHIPPED_PROJECT.glob("data_driver/*/agentic-assets/credential/*/credential.json")]
    return {f.parent.name: f.parent for f in sorted(folders)}
