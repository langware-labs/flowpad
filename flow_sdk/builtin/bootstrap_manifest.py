"""``.flowpad/bootstrap.json`` — what a template repo declares about itself.

A bootstrap repo is an engagement template: a vendor publishes it, a customer
starts a project from it, and from that moment the files are the customer's.
The manifest is how the template says what should be set up ALONGSIDE those
files — things that must not become a copy, because they are meant to keep
improving after the template is cloned::

    {
      "helpdesks": ["https://github.com/acme/acme-helpdesk"],
      "autolaunch_journey": "engagement-setup"
    }

``helpdesks`` are attached as ordinary context folders (see
``Project.add_context_dir_from_git``). That is the whole point of the split: the
template goes stale the moment it is cloned, the help desk never does, because
it stays a link to the vendor's repo rather than a copy inside the customer's.

Read defensively — this file comes from a third-party repo, and a malformed or
hostile manifest must degrade to "declares nothing" rather than fail the
project setup that is already half done. It is a *claim*, never a
capability: every URL here still goes through the same attach path (and its
consent prompt) a user typing the URL by hand would get.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

BOOTSTRAP_DIRNAME = ".flowpad"
BOOTSTRAP_FILENAME = "bootstrap.json"

# A template declaring hundreds of desks is a mistake or an attack, not a use
# case. Bounded here so one manifest cannot turn project setup into an
# unbounded series of clones.
MAX_HELPDESKS = 8


@dataclass(frozen=True)
class BootstrapManifest:
    """What a template repo declares. Empty when there is no manifest."""

    helpdesks: tuple[str, ...] = ()
    autolaunch_journey: Optional[str] = None

    def __bool__(self) -> bool:
        return bool(self.helpdesks or self.autolaunch_journey)


def bootstrap_manifest_path(repo_root: Path) -> Path:
    return Path(repo_root) / BOOTSTRAP_DIRNAME / BOOTSTRAP_FILENAME


def read_bootstrap_manifest(repo_root: Path) -> BootstrapManifest:
    """Parse ``<repo>/.flowpad/bootstrap.json``. Never raises.

    Missing file, unreadable bytes, invalid JSON, or a non-object top level all
    mean the same thing to the caller — this template declares nothing.
    """
    path = bootstrap_manifest_path(repo_root)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return BootstrapManifest()
    if not isinstance(raw, dict):
        return BootstrapManifest()

    desks: list[str] = []
    # `isinstance(list)` rather than a bare truthiness check: a string is
    # iterable, so `"https://x"` would otherwise be read as nine one-character
    # "URLs" instead of being rejected.
    declared = raw.get("helpdesks")
    for entry in declared if isinstance(declared, list) else []:
        if not isinstance(entry, str):
            continue
        url = entry.strip()
        # De-duplicated so a repeated URL doesn't produce a repeated prompt;
        # validity is the attach path's job, not ours.
        if url and url not in desks:
            desks.append(url)
        if len(desks) >= MAX_HELPDESKS:
            break

    journey = raw.get("autolaunch_journey")
    journey = journey.strip() if isinstance(journey, str) and journey.strip() else None

    return BootstrapManifest(helpdesks=tuple(desks), autolaunch_journey=journey)
