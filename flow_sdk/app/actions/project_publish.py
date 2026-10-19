"""What it takes to link a Project to the cloud — one owner.

Two callers need this exact sequence and must not drift: the Project Home
"Link to cloud" button (through the generic ``share`` action) and
``flow record share --link-project``. Before this module the sequence lived
inline in ``share_action.share_entity``, which meant the CLI could only have it
by re-implementing it — and a re-implementation that is 90% right is worse than
no CLI, because it would publish a project under weaker preconditions than the
button enforces.

The gates, in order, both fail-closed:

1. an authenticated actor,
2. a live cloud login.

The folder's own git state never blocks: published assets travel through the
project's hub-hosted repository. When the folder is a clean, pushed checkout,
its ``GitOrigin`` is returned as an informational pointer.
"""

from __future__ import annotations

from typing import Optional


class ProjectPublishBlocked(Exception):
    """A gate refused. ``code`` is the stable machine vocabulary.

    Plain Exception rather than a dataclass, matching ``AssetPublishError``: a
    dataclass exception never calls ``Exception.__init__``, leaving ``str(exc)``
    empty and the instance unhashable.
    """

    def __init__(
        self,
        code: str,
        message: str,
        status_code: int = 409,
        reason: Optional[str] = None,
        git_origin: Optional[dict] = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.reason = reason
        self.git_origin = git_origin

    def data(self) -> dict:
        # `reason`/`git_origin` always present, as the inline version emitted
        # them — a refactor should not quietly change the wire shape.
        return {"code": self.code, "reason": self.reason, "git_origin": self.git_origin}


async def assert_project_publishable(project, actor) -> "object | None":
    """Run the linking gates; return the folder's ``GitOrigin`` when it has one, else None.

    Linking a Project needs a signed-in actor and a cloud login — nothing else.
    Its published assets travel through the project's hub-hosted repository, so
    the folder need not be a git checkout, have a remote, be clean, or have
    GitHub connected. When the folder IS a clean GitHub/Git checkout, its origin
    is still returned as a pointer recipients may use; its absence never blocks.

    Raises :class:`ProjectPublishBlocked`. Mutates nothing.
    """
    from flow_sdk.app.actions.git_share_preflight_action import git_share_preflight  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key  # noqa: PLC0415
    from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415

    if not actor:
        raise ProjectPublishBlocked(
            code="authenticated_user_required",
            message="Sign in before linking a Project to the cloud",
            status_code=401,
        )
    if not resolve_hub_api_key(require_live=True):
        raise ProjectPublishBlocked(
            code="cloud_login_required",
            message="Cloud login required before linking a Project to the cloud",
            status_code=401,
        )
    try:
        preflight = await git_share_preflight(Project.get_type(), str(project.id))
        return GitOrigin.model_validate(preflight["git_origin"]) if preflight.get("available") else None
    except Exception:  # noqa: BLE001 — the folder's own git state is informational only
        return None
