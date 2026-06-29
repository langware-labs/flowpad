"""Repo action handler for Git/source control integration.

Ported from FlowPad: flowpad/hub/app/actions/repo_actions.py
Types and constants brought as-is. GitHub token lookup simplified for desktop.

Routes:
  GET/POST /api/v1/graph/repo/branches?repo_url=...
"""

import asyncio
import logging
import re
from typing import Any, Optional

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
    # Picker UI v1 — repo listing + pending invitations.
    LIST = "list"
    INVITATIONS = "invitations"
    INVITATION_ACCEPT = "invitation-accept"
    INVITATION_DECLINE = "invitation-decline"


GITHUB_PROVIDER = "github"


class GithubApiRequestConsts:
    HOSTNAME = "github.com"
    API_BASE_URL = "https://api.github.com/repos"
    USER_REPOS_URL = "https://api.github.com/user/repos"
    INVITATIONS_URL = "https://api.github.com/user/repository_invitations"
    ACCEPT_HEADER = "application/vnd.github.v3+json"
    USER_AGENT = "FlowPad-Backend/1.0"
    BEARER_TOKEN_PREFIX = "Bearer "
    CONTENT_TYPE_HEADER = "content-type"
    JSON_CONTENT_TYPE = "application/json"
    REQUEST_TIMEOUT = 10


class RequestFields:
    REPO_URL = "repo_url"
    OWNER = "owner"
    NAME = "name"
    PROVIDER = "provider"
    PAGE = "page"
    INVITATION_ID = "invitation_id"


allowed_repo_actions = [
    RepoActions.BRANCHES,
    RepoActions.LIST,
    RepoActions.INVITATIONS,
    RepoActions.INVITATION_ACCEPT,
    RepoActions.INVITATION_DECLINE,
]


def _role_from_permissions(perms: Any) -> str:
    """Map GitHub's permissions value to a flat role string.

    Tolerates: dict with {admin,push,pull} flags (most common), bare string
    ('admin'/'write'/'read'/'maintain'/'triage'), or None/missing (→ 'read').
    A surprising shape never raises — degrades to the safest role.
    """
    if isinstance(perms, dict):
        if perms.get("admin") or perms.get("maintain"):
            return "admin"
        if perms.get("push"):
            return "write"
        return "read"
    if isinstance(perms, str):
        p = perms.strip().lower()
        if p in ("admin", "owner", "maintain"):
            return "admin"
        if p in ("write", "push"):
            return "write"
        return "read"
    return "read"


# A safe path segment for a GitHub owner or repo name. GitHub itself permits
# `A-Za-z0-9_.-` and disallows leading hyphen / dot, length 1-39 (owners) /
# 1-100 (repos). We're permissive on length but strict on the character set
# and lead-character so the value can't escape the URL path.
_GITHUB_SLUG_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")

# A safe git ref name. Disallows leading dash (which would be parsed as a git
# CLI option), `..`, `~`, `^`, `:`, `?`, `*`, `[`, `\`, control chars. GitHub
# enforces a stricter subset than git itself, but this is good enough to keep
# argv clean.
_GIT_REF_NAME_RE = re.compile(r"^(?!-)[A-Za-z0-9._/-]+$")


def _safe_slug(value: str | None) -> str | None:
    """Return value if it matches the safe slug regex, else None."""
    if not value or not isinstance(value, str):
        return None
    if ".." in value or "/" in value or value.startswith("."):
        return None
    return value if _GITHUB_SLUG_RE.match(value) else None


def _parse_next_page_from_link(link_header: str | None) -> int | None:
    """Parse GitHub's RFC 5988 Link header to extract the next page number.

    Example: ``<https://api.github.com/user/repos?page=2>; rel="next", <…?page=5>; rel="last"``
    → returns 2 for "next" presence; returns None if no "next" link.
    """
    if not link_header:
        return None
    for chunk in link_header.split(","):
        if 'rel="next"' not in chunk:
            continue
        # Extract the page number from the URL inside <…>
        m = re.search(r"[?&]page=(\d+)", chunk)
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                return None
    return None


def _classify_github_error(response) -> ApiResponse | None:
    """Inspect a GitHub HTTP response and map errors to a uniform ApiFailResponse.

    Returns None if the response is OK (2xx). Otherwise returns the response
    callers should bubble up — distinguishing auth (401), rate-limit (403 with
    X-RateLimit-Remaining=0 or X-RateLimit-Used==Limit), permission denial
    (other 403), expired/gone (404/410), and other errors. The 'reconnect'
    string is canonical across all callers so the UI can pattern-match.
    """
    status = response.status_code
    if 200 <= status < 300:
        return None
    body_snippet = (response.text or "")[:300]
    if status == 401:
        return ApiFailResponse(
            message="GitHub authentication failed. Please reconnect.",
            data={"reason": "auth_invalid", "status": 401},
        )
    if status == 403:
        # Distinguish rate-limit from a real permission denial.
        remaining = response.headers.get("X-RateLimit-Remaining")
        if remaining is not None and remaining.strip() == "0":
            reset = response.headers.get("X-RateLimit-Reset", "")
            return ApiFailResponse(
                message="GitHub rate limit reached. Try again shortly.",
                data={"reason": "rate_limited", "status": 403, "reset": reset},
            )
        # Secondary rate-limit (abuse detection) returns 403 + Retry-After.
        retry_after = response.headers.get("Retry-After")
        if retry_after:
            return ApiFailResponse(
                message="GitHub rate limit reached. Try again shortly.",
                data={"reason": "rate_limited", "status": 403, "retry_after": retry_after},
            )
        return ApiFailResponse(
            message="GitHub permission denied. Token may not grant access to this resource.",
            data={"reason": "forbidden", "status": 403},
        )
    if status == 404:
        return ApiFailResponse(
            message="GitHub resource not found. The invitation/repo may have been removed.",
            data={"reason": "not_found", "status": 404},
        )
    if status == 410:
        return ApiFailResponse(
            message="GitHub invitation is no longer available.",
            data={"reason": "gone", "status": 410},
        )
    return ApiFailResponse(
        message=f"GitHub API error ({status}): {body_snippet}",
        data={"reason": "github_error", "status": status},
    )


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

        # foreign_key matches the write side in desktop_oauth.py (_save_github_token_to_sod)
        # so the SOD lookup hits the same key whether or not the request has a
        # cloud-side user_foreign_key bound to the context.
        github_credentials = await get_user_credentials(user, "github_credentials", user.id)
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
        # per_page=100 is GitHub's max; without it the default is 30, which
        # silently truncates feature-heavy repos and hides the default branch.
        # Repos with >100 branches need pagination — out of scope for v1.
        # Sync `requests.get` is offloaded to a worker thread so the FastAPI
        # event loop stays responsive while we wait on GitHub.
        response = await asyncio.to_thread(
            requests.get,
            api_url,
            headers=headers,
            params={"per_page": 100},
            timeout=GithubApiRequestConsts.REQUEST_TIMEOUT,
        )
        # Route auth/rate-limit/etc. errors through the shared classifier so
        # the UI sees the same reason/status across list, invitations, branches.
        classified = _classify_github_error(response)
        if classified is not None:
            return classified
        return _build_branches_response(response)
    except requests.exceptions.Timeout:
        return ApiFailResponse(message="Request to GitHub API timed out")
    except requests.exceptions.RequestException as e:
        return ApiFailResponse(message=f"Failed to fetch branches: {str(e)}")
    except Exception as e:
        logger.error(f"Unexpected error fetching branches: {e}")
        return ApiFailResponse(message=f"Unexpected error: {str(e)}")


async def get_branches_list(
    request_info: RequestInfo,
    repo_info: RepoReqInfo,
    owner: str | None = None,
    name: str | None = None,
) -> ApiResponse:
    """List branches. Accepts either a full ``repo_info.repo_url`` OR explicit ``owner`` + ``name``.

    Owner/name path segments are validated against ``_GITHUB_SLUG_RE`` so a
    crafted ``owner='foo/../../user/repos'`` can't redirect the GitHub API URL
    to a different endpoint.
    """
    api_url: str
    if owner is not None or name is not None:
        safe_owner = _safe_slug(owner)
        safe_name = _safe_slug(name)
        if not safe_owner or not safe_name:
            return ApiFailResponse(
                message="owner and name must be valid GitHub slugs",
                status_code=400,
            )
        api_url = f"{GithubApiRequestConsts.API_BASE_URL}/{safe_owner}/{safe_name}/branches"
    elif repo_info.repo_url:
        try:
            api_url, _o, _n = _parse_github_url(repo_info.repo_url)
        except ValueError as e:
            return ApiFailResponse(message=str(e), status_code=400)
        except Exception as e:
            return ApiFailResponse(message=f"Failed to parse repository URL: {str(e)}", status_code=400)
    else:
        return ApiFailResponse(message="Repository URL or owner+name is required", status_code=400)

    token = await _get_github_token(request_info)
    headers = _prepare_github_headers(token)

    return await _fetch_branches_from_github(api_url, headers)


# ── Picker v1: list user's repos + invitations ──────────────────────────────


async def list_user_repos(request_info: RequestInfo, page: int = 1) -> ApiResponse:
    """List repos accessible to the authenticated user (one page; caller paginates).

    Returns ``{repos: RepoSummary[], next_page: int | null, page: int}`` so the
    TS SDK can fire pages 2..N in parallel after seeing page 1's Link header.
    """
    # Clamp to a sane positive page number — a caller passing 0 or a negative
    # would otherwise produce an unexpected GitHub response shape.
    page = max(1, int(page))
    token = await _get_github_token(request_info)
    if not token:
        return ApiFailResponse(message="GitHub not connected")
    headers = _prepare_github_headers(token)

    try:
        params = {
            "per_page": 100,
            "page": page,
            "sort": "updated",
            "affiliation": "owner,collaborator,organization_member",
        }
        # Offload the sync HTTP call to a worker thread so the event loop
        # stays responsive — see the matching change in _fetch_branches_from_github.
        response = await asyncio.to_thread(
            requests.get,
            GithubApiRequestConsts.USER_REPOS_URL,
            headers=headers,
            params=params,
            timeout=GithubApiRequestConsts.REQUEST_TIMEOUT,
        )
    except requests.exceptions.Timeout:
        return ApiFailResponse(message="Request to GitHub API timed out")
    except requests.exceptions.RequestException as e:
        return ApiFailResponse(message=f"Failed to list repos: {e}")

    classified = _classify_github_error(response)
    if classified is not None:
        return classified

    raw_repos = response.json() or []
    repos = []
    for r in raw_repos:
        owner_obj = r.get("owner") or {}
        repos.append({
            "provider": GITHUB_PROVIDER,
            "owner": owner_obj.get("login", ""),
            "name": r.get("name", ""),
            "full_name": r.get("full_name", ""),
            "private": bool(r.get("private")),
            "default_branch": r.get("default_branch") or "main",
            "pushed_at": r.get("pushed_at") or "",
            "role": _role_from_permissions(r.get("permissions")),
            "html_url": r.get("html_url", ""),
            "description": r.get("description") or "",
            "fork": bool(r.get("fork")),
        })
    next_page = _parse_next_page_from_link(response.headers.get("Link"))
    return ApiSuccessResponse(data={"repos": repos, "next_page": next_page, "page": page})


async def list_invitations(request_info: RequestInfo) -> ApiResponse:
    """List pending repository invitations for the authenticated user."""
    token = await _get_github_token(request_info)
    if not token:
        return ApiFailResponse(message="GitHub not connected")
    headers = _prepare_github_headers(token)
    try:
        response = await asyncio.to_thread(
            requests.get,
            GithubApiRequestConsts.INVITATIONS_URL,
            headers=headers,
            timeout=GithubApiRequestConsts.REQUEST_TIMEOUT,
        )
    except requests.exceptions.RequestException as e:
        return ApiFailResponse(message=f"Failed to list invitations: {e}")
    classified = _classify_github_error(response)
    if classified is not None:
        return classified

    items = []
    for inv in response.json() or []:
        repo = inv.get("repository") or {}
        owner_obj = repo.get("owner") or {}
        inviter = inv.get("inviter") or {}
        items.append({
            "id": inv.get("id"),
            "repo": {
                "owner": owner_obj.get("login", ""),
                "name": repo.get("name", ""),
                "full_name": repo.get("full_name", ""),
                "private": bool(repo.get("private")),
            },
            "inviter_login": inviter.get("login", ""),
            "permissions": inv.get("permissions", ""),
            "invited_at": inv.get("created_at", ""),
            "html_url": inv.get("html_url", ""),
        })
    return ApiSuccessResponse(data={"invitations": items})


async def respond_to_invitation(request_info: RequestInfo, invitation_id: int, accept: bool) -> ApiResponse:
    """PATCH (accept) or DELETE (decline) a repository invitation."""
    token = await _get_github_token(request_info)
    if not token:
        return ApiFailResponse(message="GitHub not connected")
    headers = _prepare_github_headers(token)
    url = f"{GithubApiRequestConsts.INVITATIONS_URL}/{invitation_id}"
    try:
        if accept:
            response = await asyncio.to_thread(
                requests.patch, url, headers=headers, timeout=GithubApiRequestConsts.REQUEST_TIMEOUT
            )
        else:
            response = await asyncio.to_thread(
                requests.delete, url, headers=headers, timeout=GithubApiRequestConsts.REQUEST_TIMEOUT
            )
    except requests.exceptions.RequestException as e:
        return ApiFailResponse(message=f"Invitation response failed: {e}")
    # GitHub returns 204 No Content on success for both endpoints.
    if response.status_code in (200, 204):
        return ApiSuccessResponse(data={"ok": True, "id": invitation_id, "accepted": accept})
    classified = _classify_github_error(response)
    if classified is not None:
        return classified
    return ApiFailResponse(message=f"GitHub API error ({response.status_code}): {response.text[:300]}")


def _provider_from_body(body: dict | None) -> str:
    """Pluck the provider name from a request body, defaulting to 'github'.

    v1 only implements GitHub; the field shapes the API for GitLab / Bitbucket
    extensions later. Unknown providers return 501.
    """
    return ((body or {}).get(RequestFields.PROVIDER) or GITHUB_PROVIDER).lower()


@action.all(action_name="repo")
async def repo() -> ApiResponse:
    repo_info = None
    try:
        current_request_info = get_current_request_info()
        if not current_request_info:
            return ApiFailResponse(message="Repo error, No request info")

        # Get request data — accepts body for POST or query params for GET.
        request_data = await current_request_info.get_post_data() or {}
        # Query params (used by GET /repo/list?page=2) supplement body.
        query = getattr(current_request_info, "request_parameters", None) or {}
        body = {**query, **request_data}

        repo_url = body.get(RequestFields.REPO_URL)
        owner = body.get(RequestFields.OWNER)
        name = body.get(RequestFields.NAME)
        # `int(...)` on an attacker-supplied string can raise — catch and
        # return a 400 instead of a 500 from the catch-all middleware.
        raw_page = body.get(RequestFields.PAGE, 1)
        try:
            page = max(1, int(raw_page)) if raw_page not in (None, "") else 1
        except (TypeError, ValueError):
            return ApiFailResponse(message="page must be a positive integer", status_code=400)
        invitation_id = body.get(RequestFields.INVITATION_ID)
        provider = _provider_from_body(body)

        repo_info = get_request_repo_info()
        if repo_info.repo_action not in allowed_repo_actions:
            return ApiFailResponse(message=f"Action {repo_info.repo_action} is not allowed")

        if repo_url:
            repo_info.repo_url = repo_url

        # Provider gate — only github implemented in v1.
        if provider != GITHUB_PROVIDER:
            return ApiFailResponse(message=f"Provider '{provider}' not yet supported")

        if repo_info.repo_action == RepoActions.BRANCHES:
            return await get_branches_list(current_request_info, repo_info, owner=owner, name=name)
        if repo_info.repo_action == RepoActions.LIST:
            return await list_user_repos(current_request_info, page=page)
        if repo_info.repo_action == RepoActions.INVITATIONS:
            return await list_invitations(current_request_info)
        if repo_info.repo_action in (RepoActions.INVITATION_ACCEPT, RepoActions.INVITATION_DECLINE):
            if invitation_id in (None, ""):
                return ApiFailResponse(message="invitation_id required", status_code=400)
            try:
                inv_id_int = int(invitation_id)
            except (TypeError, ValueError):
                return ApiFailResponse(message="invitation_id must be an integer", status_code=400)
            return await respond_to_invitation(
                current_request_info,
                inv_id_int,
                accept=(repo_info.repo_action == RepoActions.INVITATION_ACCEPT),
            )
        return ApiSuccessResponse(data=[])
    except RuntimeError as e:
        msg = f"Repo error: {e.args[0]}"
        if repo_info is not None:
            msg += f" {repo_info}"
        logger.error(msg)
        return e.args[0]
