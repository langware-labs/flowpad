"""``project/<id>/git_share`` on the desk — the project's private GitHub repo, for its members.

The TS SDK and the project page call this on the LOCAL server; it delegates to
``Project.git_share`` / ``share_git`` / ``unshare_git``, which talk to the hub with
this desktop's cloud login (the desk holds it, the browser never does).

* ``GET``    — the share's status (``GitShare``).
* ``POST``   — share it (or take the next step GitHub asks for).
* ``DELETE`` — stop sharing.

A refusal the desk can see before asking the hub (the project is not linked to
the cloud, its folder has no GitHub origin) is a 409 with ``data.error_code``;
the hub's own refusals pass through with the hub's status and reason.
"""

from __future__ import annotations

from flow_sdk.actions import action
from flow_sdk.app.actions.share_action import LOCAL_MODE_SHARE_MESSAGE, _local_mode_share_blocked
from flow_sdk.builtin.project import Project
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.git_share_spec import GitShareError

#: ``data.error_code`` for a share the desk refused before reaching the hub.
NOT_SHAREABLE = "git_share_not_shareable"


@action.all(action_name="git_share", types=["project"])
async def project_git_share() -> ApiResponse:
    request_info = get_current_request_info()
    if request_info is None or request_info.target_entity_typeid is None:
        return ApiFailResponse(message="git_share: target project required", status_code=400)
    project = await Project.get_by_id(request_info.target_entity_typeid.id)
    if project is None:
        return ApiFailResponse(message="Project not found", status_code=404)

    method = request_info.method
    if method == "post":
        if _local_mode_share_blocked():
            return ApiFailResponse(message=LOCAL_MODE_SHARE_MESSAGE, status_code=403)
        verb = project.share_git
    elif method == "delete":
        verb = project.unshare_git
    else:
        verb = project.git_share

    try:
        share = await verb()
    except GitShareError as exc:
        return ApiFailResponse(message=str(exc), status_code=409, data={"error_code": NOT_SHAREABLE})
    except HubError as exc:
        return ApiFailResponse(message=exc.reason, status_code=exc.status_code or 502)
    return ApiSuccessResponse(data=share.model_dump(mode="json"))
