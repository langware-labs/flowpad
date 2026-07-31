"""Helpdesk placement rules, the stored `kind` contract, and portal-less degradation.

Three things that only break silently:

1. The portal checkout slot must land in the ONE spot where the dev "Delete"
   button can actually remove it — a descendant of the agent workspace, so it
   is not ``is_protected_path``, is a valid project cwd, and is not mistaken
   for an SDK-shipped system project.
2. ``ConversationKind`` is a PERSISTED wire value. It carries no aliases, so any
   stored spelling other than the two members below silently stops reading as a
   ticket — changing a member value requires migrating existing rows.
3. A desk with a ticket queue but NO portal is valid — and is also exactly what
   a hub predating the portal field looks like. If ``helpdesk-ensure`` treats
   that as an error, the single footer Help desk button is dead on every
   un-upgraded hub, taking the ticket flow down with it.

# do not increase timeout without approval
"""
from __future__ import annotations

import ntpath
import posixpath
from pathlib import PurePosixPath, PureWindowsPath
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions import helpdesk_action as hda
from flow_sdk.app.actions.flow_message_action import HelpdeskTarget
from flow_sdk.builtin.conversation import ConversationKind
from flow_sdk.builtin.project import HelpdeskConfig, Project
from flow_sdk.config import helpdesk_project_dir, helpdesk_root, is_system_project_path
from flow_sdk.fs_store.path_utils import is_protected_path, is_valid_project_cwd
from flow_sdk.responses.response import ApiResponseStatus

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

# The canonical desk id — a real v5 entity id, so the slot name is realistic.
DESK_ID = "4f9f1fd1-39b6-5465-9c20-cb4c59b08318"


# ── placement ───────────────────────────────────────────────────────────────


def test_slot_is_under_the_helpdesk_root() -> None:
    slot = helpdesk_project_dir(DESK_ID)
    assert slot.parent == helpdesk_root()
    assert slot.name == f"project-{DESK_ID}"


def test_slot_is_deletable_by_the_dev_reset() -> None:
    """Not protected → ``_delete_with_children`` will really rmtree it.

    If this ever flips to protected, the dev Delete button becomes a silent
    no-op (the delete path only logs "preserved protected source path").
    """
    slot = str(helpdesk_project_dir(DESK_ID))
    assert is_protected_path(slot) is False
    # include_temp=True is the form EVERY Project call site uses
    # (project.py:450/498/506/529/556/610), and it is the one that matters
    # here: under pytest the instance home is redirected beneath the system
    # temp dir, so the bare predicate would reject the slot for a reason that
    # never applies to a real user's `~/Flowpad workspace`.
    assert is_valid_project_cwd(slot, include_temp=True) is True


def test_slot_is_not_mistaken_for_a_shipped_system_project() -> None:
    """The new guard in ``_delete_with_children`` must not catch the portal.

    That guard protects ``<install>/flow_sdk/system_projects/<name>``; the
    portal sets ``system=True`` only to stay out of project pickers, and must
    remain deletable.
    """
    assert is_system_project_path(str(helpdesk_project_dir(DESK_ID))) is False


def test_slot_is_built_with_path_semantics_not_string_concat() -> None:
    """Cross-platform: the slot is assembled by pathlib, so it carries the
    host separator and never a hand-spliced '/'."""
    slot = helpdesk_project_dir(DESK_ID)
    parts = slot.parts
    assert ".flow" in parts and "helpdesk" in parts
    # The leaf must be one path component — a desk id spliced into the string
    # would show up as extra components here.
    assert parts[-1] == f"project-{DESK_ID}"
    # And the join must round-trip through both flavours without producing
    # doubled or missing separators.
    for flavour, mod in ((PurePosixPath, posixpath), (PureWindowsPath, ntpath)):
        joined = flavour(*parts)
        assert mod.basename(str(joined)) == f"project-{DESK_ID}"


def test_distinct_desks_get_distinct_slots() -> None:
    """A support chain has several desks; their portals must not collide."""
    other = "0f92d293-4535-5bd6-be4e-c1404b94f13b"
    assert helpdesk_project_dir(DESK_ID) != helpdesk_project_dir(other)


# ── the stored `kind` contract ──────────────────────────────────────────────


def test_conversation_kind_values_are_exactly_the_stored_contract() -> None:
    """``kind`` is persisted, so these strings ARE the wire contract.

    There is deliberately no alias for a superseded spelling: an accepted alias
    lets stale values live on forever. Changing either value is therefore a
    breaking change that requires migrating existing rows.
    """
    assert {k.value for k in ConversationKind} == {"direct", "helpdesk"}


def test_conversation_kind_rejects_any_other_value() -> None:
    """Including the pre-rename spellings — they must be migrated, not tolerated."""
    for stale in ("community", "help_desk", "not_a_kind"):
        with pytest.raises(ValueError):
            ConversationKind(stale)


def test_project_carries_the_helpdesk_config_with_a_portal_url() -> None:
    cfg = HelpdeskConfig(enabled=True, display_name="Flowpad Support", portal_git_url="https://x/y.git")
    proj = Project(type="project", name="desk", helpdesk=cfg)
    assert proj.helpdesk is not None
    assert proj.helpdesk.portal_git_url == "https://x/y.git"
    # A desk can answer tickets without publishing a portal.
    assert HelpdeskConfig(enabled=True).portal_git_url is None


# ── portal-less degradation ─────────────────────────────────────────────────


def _request_info() -> SimpleNamespace:
    # helpdesk_ensure only checks that someone_typeid is truthy.
    return SimpleNamespace(someone_typeid="user-aaaaaaaa-0000-0000-0000-000000000001")


@pytest.mark.asyncio
async def test_ensure_reports_no_portal_as_success_not_failure() -> None:
    """A desk that publishes no portal must NOT fail the ensure call.

    This is the shape an un-upgraded hub returns (it advertises no portal url at
    all). Failing here would break the footer's single Help Desk button on every
    such hub — and since that button replaced the separate docs + assistance
    entries, it would take the still-working ticket flow down with it. The
    caller degrades on ``has_portal: False``.
    """
    target = HelpdeskTarget(DESK_ID, None)
    with (
        patch.object(hda, "_resolve_target", AsyncMock(return_value=target)),
        patch.object(hda, "get_current_request_info", return_value=_request_info()),
    ):
        resp = await hda.helpdesk_ensure()

    assert resp.status == ApiResponseStatus.SUCCESS.value
    assert resp.data["has_portal"] is False
    # Nothing was cloned, so there is no local project or path to point at.
    assert resp.data["project_id"] is None
    assert resp.data["mount_path"] is None
    assert resp.data["cloned"] is False
    # The ticket queue is still reachable — that is what makes degrading useful.
    assert resp.data["helpdesk_project_id"] == DESK_ID


@pytest.mark.asyncio
async def test_ensure_still_fails_when_there_is_no_desk_at_all() -> None:
    """No desk is a REAL error and must stay one — the degradation above is
    scoped to 'desk exists, portal does not', not to 'nothing resolved'."""
    with (
        patch.object(hda, "_resolve_target", AsyncMock(return_value=None)),
        patch.object(hda, "get_current_request_info", return_value=_request_info()),
    ):
        resp = await hda.helpdesk_ensure()

    assert resp.status == ApiResponseStatus.FAIL.value
    # 502: the upstream hub advertises no desk; our backend is healthy.
    assert resp.status_code == 502
