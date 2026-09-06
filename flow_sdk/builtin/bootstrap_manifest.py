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

Not every field is one-shot, and the file is misread as template-only. The
setup-time reading above is one of TWO patterns here: ``content_projects`` is
re-read by ``reconcile-bootstrap`` and ``autolaunch_journey`` by the journey
opener, both long after setup, from a clone that KEPT its remote.
``always_use_skills`` is of that second kind — a standing declaration read live
on the tracked checkout, not an instruction consumed once. That is the whole
reason it lives here rather than in local settings or on the Project row: it has
to reach whoever receives the project over git, and only the repo travels.

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
# A project whose every prompt must carry a dozen skills has not chosen; it has
# listed. Bounded so a manifest cannot bloat every system prompt in the project.
MAX_ALWAYS_USE_SKILLS = 8


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
    #: Skills every session in this project should apply without being asked.
    #:
    #: A project's skills are otherwise only OFFERED to the worker — their name
    #: and description are listed in context, and the model decides. For a
    #: project whose whole point IS the skill (a help desk, a triage flow), that
    #: is the wrong default: the author wants it applied, and telling every
    #: recipient "remember to say `use triage-ticket`" does not survive being
    #: shared. Declaring it here travels with the repo, which is the only thing
    #: that reaches someone who received the project over git.
    always_use_skills: tuple[str, ...] = ()

    def __bool__(self) -> bool:
        return bool(
            self.helpdesks or self.content_projects or self.autolaunch_journey or self.always_use_skills
        )


def _capped_string_list(raw: dict, key: str, cap: int) -> tuple[str, ...]:
    """A manifest's list-of-strings field: stripped, de-duplicated, capped.

    Shared by the two string-list declarations because the DEFENSIVE part is
    what matters and must not diverge between them. In particular the
    ``isinstance(list)`` guard: a string is iterable, so a bare
    ``"triage-ticket"`` would otherwise be read as thirteen one-character
    entries rather than rejected. Anything that is not a list of strings
    declares nothing.

    ``content_projects`` deliberately keeps its own loop — its entries are
    objects with a multi-field identity, and folding that in here would add
    parameters instead of removing duplication.
    """
    out: list[str] = []
    declared = raw.get(key)
    for entry in declared if isinstance(declared, list) else []:
        if not isinstance(entry, str):
            continue
        value = entry.strip()
        # De-duplicated so a repeat cannot produce a repeated effect; validity is
        # the consuming path's job, not ours.
        if value and value not in out:
            out.append(value)
        if len(out) >= cap:
            break
    return tuple(out)


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

    desks = _capped_string_list(raw, "helpdesks", MAX_HELPDESKS)

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
        helpdesks=desks,
        content_projects=tuple(content_projects),
        autolaunch_journey=journey,
        always_use_skills=_capped_string_list(raw, "always_use_skills", MAX_ALWAYS_USE_SKILLS),
    )
