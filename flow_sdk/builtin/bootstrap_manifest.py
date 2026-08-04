"""``.flowpad/bootstrap.json`` — what a template repo declares about itself.

A bootstrap repo is an engagement template: a vendor publishes it, a customer
starts a project from it, and from that moment the files are the customer's.
The manifest is how the template says what should be set up ALONGSIDE those
files — things that must not become a copy, because they are meant to keep
improving after the template is cloned::

    {
      "content_projects": [
        {"url": "https://github.com/acme/acme-support", "branch": "main", "scope": "shared"}
      ],
      "autolaunch_journey": "engagement-setup"
    }

``content_projects`` are attached as ordinary context folders (see
``Project.add_context_dir_from_git``). That is the whole point of the split: the
template goes stale the moment it is cloned, the help desk never does, because
it stays a link to the vendor's repo rather than a copy inside the customer's.

``helpdesks`` remains supported as the legacy URL-only spelling. New manifests
should use ``content_projects`` so they can pin the branch and context scope.

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
MAX_CONTENT_PROJECTS = 8


@dataclass(frozen=True)
class BootstrapContentProject:
    """One live content dependency declared by a Project manifest."""

    url: str
    branch: str = ""
    scope: str = "shared"


@dataclass(frozen=True)
class BootstrapManifest:
    """What a template repo declares. Empty when there is no manifest."""

    helpdesks: tuple[str, ...] = ()
    content_projects: tuple[BootstrapContentProject, ...] = ()
    autolaunch_journey: Optional[str] = None

    def __bool__(self) -> bool:
        return bool(self.helpdesks or self.content_projects or self.autolaunch_journey)


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

    content_projects: list[BootstrapContentProject] = []
    seen_declarations: set[tuple[str, str, str]] = set()
    declared_content = raw.get("content_projects")
    for entry in declared_content if isinstance(declared_content, list) else []:
        if not isinstance(entry, dict):
            continue
        raw_url = entry.get("url")
        if not isinstance(raw_url, str) or not raw_url.strip():
            continue
        url = raw_url.strip()
        raw_branch = entry.get("branch", "")
        branch = raw_branch.strip() if isinstance(raw_branch, str) else ""
        raw_scope = entry.get("scope", "shared")
        scope = raw_scope.strip() if isinstance(raw_scope, str) else "shared"
        if scope not in ("private", "shared"):
            continue
        declaration = (url, branch, scope)
        if declaration in seen_declarations:
            continue
        # Preserve conflicting declarations for the semantic reconciliation
        # preflight. Silently keeping the first branch would install the wrong
        # revision; the reader stays non-throwing, while the mutating action
        # rejects the conflict before it links anything.
        seen_declarations.add(declaration)
        content_projects.append(BootstrapContentProject(url=url, branch=branch, scope=scope))
        if len(content_projects) >= MAX_CONTENT_PROJECTS:
            break

    journey = raw.get("autolaunch_journey")
    journey = journey.strip() if isinstance(journey, str) and journey.strip() else None

    return BootstrapManifest(
        helpdesks=tuple(desks),
        content_projects=tuple(content_projects),
        autolaunch_journey=journey,
    )
