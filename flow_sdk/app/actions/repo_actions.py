"""Repo action handler for Git/source control integration.

Ported from FlowPad: flowpad/hub/app/actions/repo_actions.py
Types and constants brought as-is. GitHub token lookup simplified for desktop.

Routes:
  GET/POST /api/v1/graph/repo/branches with {git_origin}
"""

import asyncio
import logging
import re
from typing import Any, Optional

import requests
from pydantic import BaseModel, ConfigDict

from flow_sdk.fs_store.origin.git_origin import GitOrigin
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
    CREATE = "create"
    INVITATIONS = "invitations"
    INVITATION_ACCEPT = "invitation-accept"
    INVITATION_DECLINE = "invitation-decline"


GITHUB_PROVIDER = "github"


class GithubApiRequestConsts:
    HOSTNAME = "github.com"
    API_BASE_URL = "https://api.github.com/repos"
    GRAPHQL_URL = "https://api.github.com/graphql"
    USER_REPOS_URL = "https://api.github.com/user/repos"
    INVITATIONS_URL = "https://api.github.com/user/repository_invitations"
    ACCEPT_HEADER = "application/vnd.github.v3+json"
    USER_AGENT = "FlowPad-Backend/1.0"
    BEARER_TOKEN_PREFIX = "Bearer "
    CONTENT_TYPE_HEADER = "content-type"
    JSON_CONTENT_TYPE = "application/json"
    REQUEST_TIMEOUT = 10


class RequestFields:
    GIT_ORIGIN = "git_origin"
    PROVIDER = "provider"
    PAGE = "page"
    INVITATION_ID = "invitation_id"
    NAME = "name"


allowed_repo_actions = [
    RepoActions.BRANCHES,
    RepoActions.LIST,
    RepoActions.CREATE,
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
    git_origin: GitOrigin | None = None

    @staticmethod
    def from_request_info(request_info: RequestInfo):
        subpath = request_info.sub_path
        if not subpath:
            raise RuntimeError("No subpath found in request info")
        sub_path_parts = subpath.split("/")
        repo_action = sub_path_parts[0]
        return RepoReqInfo(repo_action=repo_action, git_origin=None)


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


def _github_api_url_from_origin(git_origin: GitOrigin) -> tuple[str, str, str]:
    if (git_origin.provider or "").strip().lower() != GITHUB_PROVIDER:
        raise ValueError("Only GitHub repositories are supported")

    owner = _safe_slug(git_origin.owner)
    curr_repo = _safe_slug(git_origin.name)
    if not owner or not curr_repo:
        raise ValueError("owner and name must be valid GitHub slugs")

    api_url = f"{GithubApiRequestConsts.API_BASE_URL}/{owner}/{curr_repo}/branches"
    return api_url, owner, curr_repo


async def _get_github_token(request_info: RequestInfo) -> Optional[str]:
    """The request user's GitHub token; None keeps public repos working."""
    from flow_sdk.core.oauth.github_credentials import get_github_token  # noqa: PLC0415

    return await get_github_token(request_info.user)


def _prepare_github_headers(token: Optional[str]) -> dict:
    headers = {
        "Accept": GithubApiRequestConsts.ACCEPT_HEADER,
        "User-Agent": GithubApiRequestConsts.USER_AGENT,
    }

    if token:
        headers["Authorization"] = f"{GithubApiRequestConsts.BEARER_TOKEN_PREFIX}{token}"

    return headers


def _sort_branches_by_recency(branches: list[dict]) -> list[dict]:
    """Most recently changed first; undated branches keep their order at the end.

    Undated entries only occur on the REST fallback, where GitHub reports no
    date at all — sorting those to the back beats interleaving them at the
    epoch, which would read as "changed in 1970".
    """
    dated = [b for b in branches if b.get("updated_at")]
    undated = [b for b in branches if not b.get("updated_at")]
    dated.sort(key=lambda b: b["updated_at"], reverse=True)
    return dated + undated


async def _fetch_branches_from_github(api_url: str, headers: dict, owner: str = "", name: str = "") -> ApiResponse:
    """Every branch of a repo, newest change first.

    REST is the fallback rather than the primary because its branch objects
    carry no dates and it offers no sort, so the picker could only ever be
    alphabetical. GraphQL returns the same refs *with* each one's
    ``committedDate`` in the same number of round trips.
    """
    try:
        branches = await _fetch_branches_graphql(owner, name, headers)
        if branches is None:
            branches = await _fetch_branches_rest(api_url, headers)
            if isinstance(branches, ApiResponse):
                return branches  # an error worth reporting; don't paper over it
        return ApiSuccessResponse(data=_sort_branches_by_recency(branches))
    except requests.exceptions.Timeout:
        return ApiFailResponse(message="Request to GitHub API timed out")
    except requests.exceptions.RequestException as e:
        return ApiFailResponse(message=f"Failed to fetch branches: {str(e)}")
    except Exception as e:
        logger.error(f"Unexpected error fetching branches: {e}")
        return ApiFailResponse(message=f"Unexpected error: {str(e)}")


async def _fetch_branches_rest(api_url: str, headers: dict) -> list[dict] | ApiResponse:
    """All pages of GitHub's REST branch list, in GitHub's own (alphabetical) order.

    per_page=100 is GitHub's max; the default is 30. Following the ``Link``
    header matters as much as the page size: flowpad-hub has 228 branches, and
    page 1 alphabetically stops at "compose" — so every ``release/*`` used to be
    invisible with no error anywhere.
    """
    collected: list[dict] = []
    page = 1
    while True:
        # Sync `requests.get` is offloaded to a worker thread so the FastAPI
        # event loop stays responsive while we wait on GitHub.
        response = await asyncio.to_thread(
            requests.get,
            api_url,
            headers=headers,
            params={"per_page": 100, "page": page},
            timeout=GithubApiRequestConsts.REQUEST_TIMEOUT,
        )
        # Route auth/rate-limit/etc. errors through the shared classifier so
        # the UI sees the same reason/status across list, invitations, branches.
        classified = _classify_github_error(response)
        if classified is not None:
            return classified
        collected.extend(
            {"name": b["name"], "protected": b.get("protected", False), "updated_at": ""}
            for b in response.json() or []
        )
        next_page = _parse_next_page_from_link(response.headers.get("Link"))
        if next_page is None:
            return collected
        page = next_page


_BRANCHES_GRAPHQL = """
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        branchProtectionRule { id }
        target { ... on Commit { committedDate } }
      }
    }
  }
}
"""


async def _fetch_branches_graphql(owner: str, name: str, headers: dict) -> list[dict] | None:
    """Branches with their last-change date, or None if GraphQL can't answer.

    GraphQL always requires a token, so an anonymous read of a public repo lands
    here with nothing to send — that's a `None`, not an error, and the caller
    falls back to REST.
    """
    if "Authorization" not in headers:
        return None
    collected: list[dict] = []
    cursor: str | None = None
    while True:
        response = await asyncio.to_thread(
            requests.post,
            GithubApiRequestConsts.GRAPHQL_URL,
            headers=headers,
            json={"query": _BRANCHES_GRAPHQL, "variables": {"owner": owner, "name": name, "cursor": cursor}},
            timeout=GithubApiRequestConsts.REQUEST_TIMEOUT,
        )
        if response.status_code != 200:
            return None
        body = response.json() or {}
        # A GraphQL error arrives as HTTP 200 with an `errors` array.
        if body.get("errors"):
            logger.warning(f"GraphQL branch listing failed for {owner}/{name}: {body['errors']}")
            return None
        refs = ((body.get("data") or {}).get("repository") or {}).get("refs")
        if refs is None:
            return None
        for node in refs.get("nodes") or []:
            collected.append(
                {
                    "name": node.get("name", ""),
                    "protected": bool(node.get("branchProtectionRule")),
                    "updated_at": ((node.get("target") or {}).get("committedDate")) or "",
                }
            )
        page_info = refs.get("pageInfo") or {}
        if not page_info.get("hasNextPage"):
            return collected
        cursor = page_info.get("endCursor")


async def get_branches_list(
    request_info: RequestInfo,
    repo_info: RepoReqInfo,
) -> ApiResponse:
    """List branches for ``repo_info.git_origin``.

    The origin's owner/name coordinates are validated against ``_GITHUB_SLUG_RE``
    so a crafted owner value can't redirect the GitHub API URL to a different
    endpoint.
    """
    if not repo_info.git_origin:
        return ApiFailResponse(message="git_origin is required", status_code=400)
    try:
        api_url, _o, _n = _github_api_url_from_origin(repo_info.git_origin)
    except ValueError as e:
        return ApiFailResponse(message=str(e), status_code=400)
    except Exception as e:
        return ApiFailResponse(message=f"Failed to parse git_origin: {str(e)}", status_code=400)

    token = await _get_github_token(request_info)
    headers = _prepare_github_headers(token)

    return await _fetch_branches_from_github(api_url, headers, owner=_o, name=_n)


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
    repos = [_repo_summary(r) for r in raw_repos]
    next_page = _parse_next_page_from_link(response.headers.get("Link"))
    return ApiSuccessResponse(data={"repos": repos, "next_page": next_page, "page": page})


def _repo_summary(raw: dict, *, default_role: str = "read") -> dict:
    owner = (raw.get("owner") or {}).get("login", "")
    name = raw.get("name", "")
    default_branch = raw.get("default_branch") or "main"
    return {
        "provider": GITHUB_PROVIDER,
        "owner": owner,
        "name": name,
        "full_name": raw.get("full_name", ""),
        "private": bool(raw.get("private")),
        "default_branch": default_branch,
        "pushed_at": raw.get("pushed_at") or "",
        "role": _role_from_permissions(raw.get("permissions")) if raw.get("permissions") else default_role,
        "html_url": raw.get("html_url", ""),
        "description": raw.get("description") or "",
        "fork": bool(raw.get("fork")),
        "git_origin": GitOrigin(
            provider=GITHUB_PROVIDER,
            owner=owner,
            name=name,
            branch=default_branch,
            rel_path=".",
        ).model_dump(mode="json"),
    }


async def create_private_repo(request_info: RequestInfo, name: str) -> ApiResponse:
    """Create one initialized private GitHub repository for install targeting."""
    safe_name = _safe_slug(name)
    if not safe_name or len(safe_name) > 100:
        return ApiFailResponse(message="name must be a valid GitHub repository name", status_code=400)
    token = await _get_github_token(request_info)
    if not token:
        return ApiFailResponse(message="GitHub not connected")
    try:
        response = await asyncio.to_thread(
            requests.post,
            GithubApiRequestConsts.USER_REPOS_URL,
            headers=_prepare_github_headers(token),
            json={"name": safe_name, "private": True, "auto_init": True},
            timeout=GithubApiRequestConsts.REQUEST_TIMEOUT,
        )
    except requests.exceptions.RequestException as exc:
        return ApiFailResponse(message=f"Failed to create repo: {exc}")
    classified = _classify_github_error(response)
    if classified is not None:
        return classified
    return ApiSuccessResponse(data={"repo": _repo_summary(response.json() or {}, default_role="admin")})


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

        raw_git_origin = body.get(RequestFields.GIT_ORIGIN)
        git_origin = None
        if raw_git_origin not in (None, ""):
            try:
                git_origin = GitOrigin.model_validate(raw_git_origin)
            except Exception as e:
                return ApiFailResponse(message=f"git_origin is invalid: {e}", status_code=400)
        # `int(...)` on an attacker-supplied string can raise — catch and
        # return a 400 instead of a 500 from the catch-all middleware.
        raw_page = body.get(RequestFields.PAGE, 1)
        try:
            page = max(1, int(raw_page)) if raw_page not in (None, "") else 1
        except (TypeError, ValueError):
            return ApiFailResponse(message="page must be a positive integer", status_code=400)
        invitation_id = body.get(RequestFields.INVITATION_ID)
        repo_name = str(body.get(RequestFields.NAME) or "").strip()
        provider = _provider_from_body(body)

        repo_info = get_request_repo_info()
        if repo_info.repo_action not in allowed_repo_actions:
            return ApiFailResponse(message=f"Action {repo_info.repo_action} is not allowed")

        repo_info.git_origin = git_origin

        # Provider gate — only github implemented in v1.
        if git_origin and git_origin.provider:
            provider = git_origin.provider.lower()
        if provider != GITHUB_PROVIDER:
            return ApiFailResponse(message=f"Provider '{provider}' not yet supported")

        if repo_info.repo_action == RepoActions.BRANCHES:
            return await get_branches_list(current_request_info, repo_info)
        if repo_info.repo_action == RepoActions.LIST:
            return await list_user_repos(current_request_info, page=page)
        if repo_info.repo_action == RepoActions.CREATE:
            return await create_private_repo(current_request_info, repo_name)
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
