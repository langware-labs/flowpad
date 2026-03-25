"""Repo action handler for Git/source control integration.

Ported from FlowPad: flowpad/hub/app/actions/repo_actions.py
Types and constants brought as-is. GitHub token lookup simplified for desktop.

Routes:
  GET/POST /api/v1/graph/repo/branches?repo_url=...
"""

import logging
from typing import Optional

import requests
from pydantic import BaseModel, ConfigDict

from flow_sdk.core import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.request_context.request_info import RequestInfo
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


# Constants — brought as-is from production
class RepoActions:
    BRANCHES = "branches"


GITHUB_PROVIDER = "github"


class GithubApiRequestConsts:
    HOSTNAME = "github.com"
    API_BASE_URL = "https://api.github.com/repos"
    ACCEPT_HEADER = "application/vnd.github.v3+json"
    USER_AGENT = "FlowPad-Backend/1.0"
    BEARER_TOKEN_PREFIX = "Bearer "
    CONTENT_TYPE_HEADER = "content-type"
    JSON_CONTENT_TYPE = "application/json"
    REQUEST_TIMEOUT = 10


class RequestFields:
    REPO_URL = "repo_url"


allowed_repo_actions = [
    RepoActions.BRANCHES,
]


class RepoReqInfo(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    repo_action: str
    repo_url: str | None = None

    @staticmethod
    def from_request_info(request_info: RequestInfo):
        subpath = request_info.sub_path
        if not subpath:
            raise RuntimeError("No subpath found in request info")
        sub_path_parts = subpath.split("/")
        repo_action = sub_path_parts[0]
        return RepoReqInfo(repo_action=repo_action, repo_url=None)


def get_request_repo_info() -> RepoReqInfo:
    current_request_info = get_current_request_info()
    if not current_request_info:
        res = ApiFailResponse(message="No request info found")
        raise RuntimeError(res)
    if not current_request_info.action:
        res = ApiFailResponse(message="No action found in request info")
        raise RuntimeError(res)
    if current_request_info.action != "repo":
        res = ApiFailResponse(message="Action is not repo")
        raise RuntimeError(res)
    if not current_request_info.sub_path:
        res = ApiFailResponse(message="No subpath found in request info")
        raise RuntimeError(res)
    return RepoReqInfo.from_request_info(current_request_info)


def _parse_github_url(repo_url: str) -> tuple[str, str, str]:
    clean_url = repo_url.replace(".git", "")
    if GithubApiRequestConsts.HOSTNAME not in clean_url:
        raise ValueError("Only GitHub repositories are supported")

    parts = clean_url.split("/")
    if GithubApiRequestConsts.HOSTNAME in parts:
        github_index = parts.index(GithubApiRequestConsts.HOSTNAME)
        if len(parts) < github_index + 3:
            raise ValueError("Invalid GitHub URL format")
        owner = parts[github_index + 1]
        curr_repo = parts[github_index + 2]
    else:
        raise ValueError("Invalid GitHub URL")

    api_url = f"{GithubApiRequestConsts.API_BASE_URL}/{owner}/{curr_repo}/branches"
    return api_url, owner, curr_repo


async def _get_github_token(request_info: RequestInfo) -> Optional[str]:
    """Get GitHub token for the current user.

    Desktop mode: attempts to read from SOD credentials.
    Returns None if no token is available (public repos still work).
    """
    try:
        from flow_sdk.request_context.methods import get_user_credentials
        from flow_sdk.builtin.user import User

        user = await User.get_by_typeid(request_info.user)
        if not user:
            return None

        github_credentials = await get_user_credentials(user, "github_credentials", None)
        if not github_credentials:
            return None

        return github_credentials
    except Exception as e:
        logger.warning(f"Could not get GitHub credentials: {e}")
        return None


def _prepare_github_headers(token: Optional[str]) -> dict:
    headers = {
        "Accept": GithubApiRequestConsts.ACCEPT_HEADER,
        "User-Agent": GithubApiRequestConsts.USER_AGENT,
    }

    if token:
        headers["Authorization"] = f"{GithubApiRequestConsts.BEARER_TOKEN_PREFIX}{token}"

    return headers


def _build_branches_response(response: requests.Response) -> ApiResponse:
    if response.status_code == 200:
        branches = response.json()
        simplified_branches = [
            {"name": branch["name"], "protected": branch.get("protected", False)} for branch in branches
        ]
        return ApiSuccessResponse(data=simplified_branches)

    elif response.status_code == 404:
        return ApiFailResponse(message="Repository not found or you don't have access to it")

    elif response.status_code == 401 or response.status_code == 403:
        return ApiFailResponse(message="Authentication failed. Please reconnect your GitHub account.")

    else:
        content_type = response.headers.get(GithubApiRequestConsts.CONTENT_TYPE_HEADER, "")
        if content_type.startswith(GithubApiRequestConsts.JSON_CONTENT_TYPE):
            error_data = response.json()
        else:
            error_data = {"message": response.text}

        error_message = error_data.get("message", "Unknown error")
        return ApiFailResponse(message=f"GitHub API error: {error_message}")


async def _fetch_branches_from_github(api_url: str, headers: dict) -> ApiResponse:
    try:
        response = requests.get(api_url, headers=headers, timeout=GithubApiRequestConsts.REQUEST_TIMEOUT)
        return _build_branches_response(response)
    except requests.exceptions.Timeout:
        return ApiFailResponse(message="Request to GitHub API timed out")
    except requests.exceptions.RequestException as e:
        return ApiFailResponse(message=f"Failed to fetch branches: {str(e)}")
    except Exception as e:
        logger.error(f"Unexpected error fetching branches: {e}")
        return ApiFailResponse(message=f"Unexpected error: {str(e)}")


async def get_branches_list(request_info: RequestInfo, repo_info: RepoReqInfo) -> ApiResponse:
    if not repo_info.repo_url:
        return ApiFailResponse(message="Repository URL is required")

    try:
        api_url, owner, curr_repo = _parse_github_url(repo_info.repo_url)
    except ValueError as e:
        return ApiFailResponse(message=str(e))
    except Exception as e:
        return ApiFailResponse(message=f"Failed to parse repository URL: {str(e)}")

    token = await _get_github_token(request_info)
    headers = _prepare_github_headers(token)

    return await _fetch_branches_from_github(api_url, headers)


@action.all(action_name="repo")
async def repo() -> ApiResponse:
    repo_info = None
    try:
        current_request_info = get_current_request_info()
        if not current_request_info:
            return ApiFailResponse(message="Repo error, No request info")

        # Get request data to extract repo_url
        request_data = await current_request_info.get_post_data()
        repo_url = request_data.get(RequestFields.REPO_URL) if request_data else None

        repo_info = get_request_repo_info()
        if repo_info.repo_action not in allowed_repo_actions:
            return ApiFailResponse(message=f"Action {repo_info.repo_action} is not allowed")

        if repo_url:
            repo_info.repo_url = repo_url

        if repo_info.repo_action == RepoActions.BRANCHES:
            return await get_branches_list(current_request_info, repo_info)

        return ApiSuccessResponse(data=[])
    except RuntimeError as e:
        msg = f"Repo error: {e.args[0]}"
        if repo_info is not None:
            msg += f" {repo_info}"
        logger.error(msg)
        return e.args[0]
