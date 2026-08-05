"""What it takes to link a Project to the cloud — one owner.

Two callers need this exact sequence and must not drift: the Project Home
"Link to cloud" button (through the generic ``share`` action) and
``flow record share --link-project``. Before this module the sequence lived
inline in ``share_action.share_entity``, which meant the CLI could only have it
by re-implementing it — and a re-implementation that is 90% right is worse than
no CLI, because it would publish a project under weaker preconditions than the
button enforces.

The gates, in order, all of them fail-closed:

1. an authenticated actor,
2. cloud credentials,
3. a GitHub token — the hub clones from GitHub, so a project with no token is
   a declaration nobody can act on,
4. the authoritative git preflight (clean tree, named branch, pushed, supported
   origin). The frontend never shells git; this is the only verdict.

The origin that passed the preflight is the one carried forward — re-deriving
it afterwards would open a window where the advertised commit is not the one
that was checked.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

#: Fail-closed preflight verdict, used when the probe itself raises.
_STATUS_FAILURE = {
    "available": False,
    "reason": "Couldn't read the repository's Git status.",
    "code": "status-failure",
    "git_origin": None,
}


@dataclass
class ProjectPublishBlocked(Exception):
    """A gate refused. ``code`` is the stable machine vocabulary."""

    code: str
    message: str
    status_code: int = 409
    reason: Optional[str] = None
    git_origin: Optional[dict] = None

    def data(self) -> dict:
        payload: dict = {"code": self.code}
        if self.reason is not None:
            payload["reason"] = self.reason
        if self.git_origin is not None:
            payload["git_origin"] = self.git_origin
        return payload


async def assert_project_publishable(project, actor) -> "object":
    """Run every gate and return the ``GitOrigin`` that passed the preflight.

    Raises :class:`ProjectPublishBlocked`. Mutates nothing — callers decide
    whether to proceed, which is what lets ``--dry-run`` and the
    "should I suggest linking?" question be answered without side effects.
    """
    from flow_sdk.app.actions.git_share_preflight_action import git_share_preflight  # noqa: PLC0415
    from flow_sdk.builtin.git_origin import GitOrigin  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
    from flow_sdk.core.oauth.github_credentials import get_github_token  # noqa: PLC0415

    if not actor:
        raise ProjectPublishBlocked(
            code="authenticated_user_required",
            message="Sign in before linking a Project to the cloud",
            status_code=401,
        )

    credentials = load_credentials()
    if not credentials or not credentials.api_key:
        raise ProjectPublishBlocked(
            code="cloud_login_required",
            message="Cloud login required before linking a Project to the cloud",
            status_code=401,
        )
    if not await get_github_token(actor):
        raise ProjectPublishBlocked(
            code="github_not_connected",
            message="Connect GitHub before linking a Project to the cloud",
        )

    try:
        preflight = await git_share_preflight(Project.get_type(), str(project.id))
    except Exception:  # noqa: BLE001 — publication eligibility fails closed
        logger.exception("[share] Project Git preflight failed for %s", project.id)
        preflight = _STATUS_FAILURE

    if not preflight.get("available"):
        raise ProjectPublishBlocked(
            code=str(preflight.get("code") or "status-failure"),
            message=str(preflight.get("reason") or "Project is not ready to link to the cloud"),
            reason=preflight.get("reason"),
            git_origin=preflight.get("git_origin"),
        )

    try:
        return GitOrigin.model_validate(preflight.get("git_origin"))
    except Exception as exc:  # noqa: BLE001 — a malformed success must fail closed
        raise ProjectPublishBlocked(
            code="status-failure",
            message="Couldn't determine a valid Git origin for this Project",
        ) from exc
