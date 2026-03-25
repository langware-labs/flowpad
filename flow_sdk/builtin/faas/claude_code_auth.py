"""
Claude Code authentication detection utility.

Detects Claude Code authentication status from various sources:
1. System environment variables (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY)
2. Claude Code credentials file (~/.claude/.credentials.json)
3. Claude Code settings file (~/.claude/settings.json)

Ported from FlowPad: flowpad/plugins/anthropic/claude_code_auth.py
"""

import json
import logging
import os
import platform
import subprocess
import time
from enum import StrEnum
from pathlib import Path
from typing import List, Optional

from pydantic import BaseModel

from flow_sdk.utils.claude_paths import get_user_home_path

# Platform constant
PLATFORM_DARWIN = "darwin"

# Anthropic OAuth constants
ANTHROPIC_API_KEY_ENV_VAR = "ANTHROPIC_API_KEY"
CLAUDE_CODE_OAUTH_TOKEN_NAME = "CLAUDE_CODE_OAUTH_TOKEN"
ANTHROPIC_CLIENT_ID_DEFAULT = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
ANTHROPIC_PROVIDER_NAME = "anthropic"

# Anthropic OAuth client ID (overridable via env var)
ANTHROPIC_CLIENT_ID = os.getenv("ANTHROPIC_CLIENT_ID", ANTHROPIC_CLIENT_ID_DEFAULT)
TOKEN_REFRESH_URL = "https://console.anthropic.com/v1/oauth/token"


class ClaudeCodeAuthMethod(StrEnum):
    OAUTH = "oauth"
    API_KEY = "api_key"
    NONE = "none"


class OAuthInfo(BaseModel):
    subscription_type: Optional[str] = None  # "max", "pro", "free"
    rate_limit_tier: Optional[str] = None
    scopes: List[str] = []
    expires_at: Optional[int] = None  # Unix timestamp (ms)
    is_expired: bool = False


class ApiKeyInfo(BaseModel):
    key_prefix: str  # "sk-ant-api01-***" (masked!)
    source: str  # "environment", "settings.json"


class UserProfileInfo(BaseModel):
    email: Optional[str] = None
    account_uuid: Optional[str] = None
    organization_name: Optional[str] = None
    organization_uuid: Optional[str] = None


class ClaudeCodeAuthStatus(BaseModel):
    is_authenticated: bool = False
    auth_method: ClaudeCodeAuthMethod = ClaudeCodeAuthMethod.NONE
    oauth_info: Optional[OAuthInfo] = None
    api_key_info: Optional[ApiKeyInfo] = None
    user_profile: Optional[UserProfileInfo] = None
    credentials_source: Optional[str] = None
    error: Optional[str] = None


class TokenRefreshResult(BaseModel):
    """Result of a token refresh operation."""

    success: bool = False
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    expires_at: Optional[int] = None
    user_profile: Optional[UserProfileInfo] = None
    oauth_info: Optional[OAuthInfo] = None
    error: Optional[str] = None


def mask_api_key(key: str) -> str:
    """Mask API key for safe display. Never expose full key!"""
    if not key:
        return ""
    if len(key) <= 16:
        return key[:4] + "***"
    return key[:12] + "***" + key[-4:]


def get_credentials_file_path() -> Path:
    """Get path to ~/.claude/.credentials.json (cross-platform)."""
    return get_user_home_path() / ".claude" / ".credentials.json"


def _read_credentials_from_file() -> Optional[dict]:
    """Read credentials from file (Windows/Linux)."""
    creds_path = get_credentials_file_path()
    logging.info(f"[Claude Auth Debug] _read_credentials_from_file: path={creds_path}, exists={creds_path.exists()}")
    if not creds_path.exists():
        return None
    try:
        with open(creds_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        logging.info(f"[Claude Auth Debug] _read_credentials_from_file: loaded OK, top-level keys={list(data.keys())}")
        return data
    except (json.JSONDecodeError, IOError) as e:
        logging.warning(f"[Claude Auth Debug] _read_credentials_from_file: failed to read: {e}")
        return None


def _read_credentials_from_keychain() -> Optional[dict]:
    """Read credentials from macOS Keychain."""
    login_keychain = os.path.expanduser("~/Library/Keychains/login.keychain-db")
    # No -a filter: just find any "Claude Code-credentials" entry.
    # FlowPad no longer writes to Keychain, so whatever's there is from Claude Code CLI.
    cmd = ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]
    if os.path.exists(login_keychain):
        cmd.append(login_keychain)
    logging.info(f"[Keychain Debug] cmd={' '.join(cmd)}")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        logging.info(f"[Keychain Debug] returncode={result.returncode}, stderr={result.stderr.strip()}")
        if result.returncode == 0:
            return json.loads(result.stdout.strip())
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError) as e:
        logging.info(f"[Keychain Debug] exception: {e}")
    return None


def read_credentials() -> Optional[dict]:
    """Read credentials from the platform-appropriate store.

    On macOS: reads from Keychain only (Claude Code CLI stores there).
    On Linux/Windows: reads from ~/.claude/.credentials.json.
    """
    current_platform = platform.system().lower()
    logging.info(f"[Claude Auth Debug] read_credentials: platform={current_platform}")
    if current_platform == PLATFORM_DARWIN:
        # Check for stale .credentials.json that CC or an older FlowPad version may have left behind
        creds_file_path = get_credentials_file_path()
        if creds_file_path.exists():
            logging.warning(
                f"[Claude Auth Debug] STALE FILE DETECTED on macOS: "
                f"{creds_file_path} exists alongside Keychain. "
                f"FlowPad reads from Keychain only on macOS, but Claude Code "
                f"may read from this file. If its tokens are stale, CC could "
                f"be using expired credentials while Keychain has fresh ones (or vice versa)."
            )
        result = _read_credentials_from_keychain()
        logging.info(
            f"[Claude Auth Debug] read_credentials (macOS Keychain): "
            f"got_data={result is not None}, "
            f"keys={list(result.keys()) if result else 'N/A'}"
        )
        return result
    result = _read_credentials_from_file()
    logging.info(
        f"[Claude Auth Debug] read_credentials (file): "
        f"got_data={result is not None}, "
        f"keys={list(result.keys()) if result else 'N/A'}"
    )
    return result


def _write_credentials_to_file(credentials: dict) -> bool:
    """Write credentials to file (Linux/Windows)."""
    creds_path = get_credentials_file_path()
    logging.info(
        f"[Claude Auth Debug] _write_credentials_to_file: path={creds_path}, "
        f"keys_being_written={list(credentials.keys())}"
    )
    try:
        creds_path.parent.mkdir(parents=True, exist_ok=True)
        with open(creds_path, "w", encoding="utf-8") as f:
            json.dump(credentials, f, indent=2)
        logging.info(f"[Claude Auth] Wrote credentials to {creds_path}")
        return True
    except (IOError, OSError) as e:
        logging.error(f"[Claude Auth] Failed to write credentials file: {e}")
        return False


def _write_credentials_to_keychain(credentials: dict) -> bool:
    """Write credentials to macOS Keychain."""
    try:
        credentials_json = json.dumps(credentials)
        logging.info(
            f"[Claude Auth Debug] _write_credentials_to_keychain: "
            f"keys_being_written={list(credentials.keys())}, "
            f"oauth_keys={list(credentials.get('claudeAiOauth', {}).keys()) if 'claudeAiOauth' in credentials else 'N/A'}"
        )
        # First try to delete any existing entry (ignore errors if not found)
        del_result = subprocess.run(
            ["security", "delete-generic-password", "-s", "Claude Code-credentials"],
            capture_output=True,
            timeout=5,
        )
        logging.info(
            f"[Claude Auth Debug] _write_credentials_to_keychain: "
            f"delete old entry returncode={del_result.returncode} "
            f"(0=deleted, 44=not found)"
        )
        # Add new entry
        result = subprocess.run(
            [
                "security",
                "add-generic-password",
                "-s",
                "Claude Code-credentials",
                "-a",
                Path.home().name,
                "-w",
                credentials_json,
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            logging.info("[Claude Auth] Wrote credentials to macOS Keychain")
            return True
        else:
            logging.error(f"[Claude Auth] Failed to write to Keychain: {result.stderr}")
            return False
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        logging.error(f"[Claude Auth] Failed to write to Keychain: {e}")
        return False


def write_credentials(credentials: dict) -> bool:
    """Write credentials to the platform-appropriate store.

    On macOS: writes to Keychain (where Claude Code CLI reads from).
    On Linux/Windows: writes to ~/.claude/.credentials.json.

    NOTE: Only used for initial token writes from the desktop OAuth flow.
    Do NOT use this to refresh tokens — Claude Code manages its own
    token refresh lifecycle, and consuming the single-use refresh token
    would invalidate Claude Code's copy and force re-login.
    """
    write_platform = platform.system().lower()
    logging.info(
        f"[Claude Auth Debug] write_credentials: platform={write_platform}, "
        f"writing to={'Keychain' if write_platform == PLATFORM_DARWIN else 'file'}, "
        f"top_keys={list(credentials.keys())}"
    )
    if write_platform == PLATFORM_DARWIN:
        return _write_credentials_to_keychain(credentials)
    return _write_credentials_to_file(credentials)


def save_oauth_token_response(token_response: dict) -> bool:
    """Save OAuth token response in Claude Code format.

    Called after desktop OAuth flow completes. Writes fresh tokens to
    the platform-appropriate store so Claude Code can pick them up.

    NOTE: This is for initial token writes only. Claude Code will manage
    token refreshes from here — do NOT call refresh_oauth_token separately.
    """
    # Read existing credentials to preserve subscriptionType/rateLimitTier
    existing_creds = read_credentials()
    existing_oauth = existing_creds.get("claudeAiOauth", {}) if existing_creds else {}
    preserved_metadata = existing_creds.get("claudeAiOauthMetadata", {}) if existing_creds else {}

    # DEBUG: Log what exists vs what we're about to overwrite
    existing_top_keys = list(existing_creds.keys()) if existing_creds else []
    dropped_keys = [k for k in existing_top_keys if k not in ("claudeAiOauth", "claudeAiOauthMetadata")]
    logging.info(
        f"[Claude Auth Debug] save_oauth_token_response: "
        f"existing_top_keys={existing_top_keys}, "
        f"existing_oauth_keys={list(existing_oauth.keys())}, "
        f"KEYS_THAT_WILL_BE_DROPPED={dropped_keys}, "
        f"existing_has_refreshToken={bool(existing_oauth.get('refreshToken'))}, "
        f"new_has_refresh_token={bool(token_response.get('refresh_token'))}"
    )

    # Handle expires_in -> expiresAt conversion if needed
    expires_at = token_response.get("expires_at")
    if not expires_at and token_response.get("expires_in"):
        expires_at = int((time.time() + token_response["expires_in"]) * 1000)

    # Parse scopes from space-separated string to list
    scope_str = token_response.get("scope", "")
    scopes = scope_str.split(" ") if scope_str else []

    # Extract account and organization info from token response
    account = token_response.get("account", {})
    organization = token_response.get("organization", {})

    # Determine subscription info: token response > existing OAuth > preserved metadata
    subscription_type = (
        token_response.get("subscription_type")
        or existing_oauth.get("subscriptionType")
        or preserved_metadata.get("subscriptionType")
    )
    rate_limit_tier = (
        token_response.get("rate_limit_tier")
        or existing_oauth.get("rateLimitTier")
        or preserved_metadata.get("rateLimitTier")
    )

    claude_oauth_data = {
        "accessToken": token_response.get("access_token"),
        "refreshToken": token_response.get("refresh_token"),
        "expiresAt": expires_at,
        "subscriptionType": subscription_type,
        "rateLimitTier": rate_limit_tier,
        "scopes": scopes,
        "accountEmail": account.get("email_address") or preserved_metadata.get("accountEmail"),
        "accountUuid": account.get("uuid") or preserved_metadata.get("accountUuid"),
        "organizationName": organization.get("name") or preserved_metadata.get("organizationName"),
        "organizationUuid": organization.get("uuid") or preserved_metadata.get("organizationUuid"),
    }

    # Remove None values
    claude_oauth_data = {k: v for k, v in claude_oauth_data.items() if v is not None}

    credentials = {"claudeAiOauth": claude_oauth_data}
    logging.info(
        f"[Claude Auth Debug] save_oauth_token_response: WRITING credentials with "
        f"top_keys={list(credentials.keys())}, "
        f"oauth_keys={list(claude_oauth_data.keys())}, "
        f"has_accessToken={bool(claude_oauth_data.get('accessToken'))}, "
        f"has_refreshToken={bool(claude_oauth_data.get('refreshToken'))}, "
        f"expiresAt={claude_oauth_data.get('expiresAt')}"
    )
    creds_written = write_credentials(credentials)

    # Also write hasCompletedOnboarding to ~/.claude.json to skip onboarding wizard
    _write_onboarding_complete()

    return creds_written


def _write_onboarding_complete() -> bool:
    """Write hasCompletedOnboarding: true to ~/.claude.json to skip Claude Code onboarding wizard."""
    claude_json_path = Path.home() / ".claude.json"
    try:
        existing_data = {}
        if claude_json_path.exists():
            try:
                with open(claude_json_path, "r") as f:
                    existing_data = json.load(f)
            except (json.JSONDecodeError, IOError):
                existing_data = {}

        existing_data["hasCompletedOnboarding"] = True

        with open(claude_json_path, "w") as f:
            json.dump(existing_data, f, indent=2)

        logging.info(f"[Anthropic] Wrote hasCompletedOnboarding to {claude_json_path}")
        return True
    except Exception as e:
        logging.warning(f"[Anthropic] Failed to write hasCompletedOnboarding to {claude_json_path}: {e}")
        return False


def extract_user_profile_from_token_response(token_response: dict) -> Optional[UserProfileInfo]:
    """Extract user profile from token response."""
    account = token_response.get("account", {})
    organization = token_response.get("organization", {})

    if not account and not organization:
        return None

    return UserProfileInfo(
        email=account.get("email_address"),
        account_uuid=account.get("uuid"),
        organization_name=organization.get("name"),
        organization_uuid=organization.get("uuid"),
    )


def _extract_oauth_info_from_token_response(token_response: dict) -> OAuthInfo:
    """Extract OAuth info from a token response."""
    expires_at = token_response.get("expires_at")
    is_expired = False

    if expires_at:
        current_time_ms = int(time.time() * 1000)
        is_expired = expires_at < current_time_ms

    return OAuthInfo(
        subscription_type=token_response.get("subscription_type"),
        rate_limit_tier=token_response.get("rate_limit_tier"),
        scopes=token_response.get("scope", "").split(" ") if token_response.get("scope") else [],
        expires_at=expires_at,
        is_expired=is_expired,
    )


#
# async def refresh_oauth_token(refresh_token: str) -> TokenRefreshResult:
#     """Refresh an expired OAuth token using the refresh token."""
#     import httpx
#
#     try:
#         token_data = {
#             "grant_type": "refresh_token",
#             "client_id": ANTHROPIC_CLIENT_ID,
#             "refresh_token": refresh_token,
#         }
#
#         async with httpx.AsyncClient() as client:
#             response = await client.post(
#                 TOKEN_REFRESH_URL,
#                 json=token_data,
#                 headers={
#                     "Content-Type": "application/json",
#                     "Accept": "application/json",
#                 },
#                 timeout=30.0,
#             )
#
#             if response.status_code != 200:
#                 error_text = response.text
#                 try:
#                     error_json = response.json()
#                     if "error" in error_json:
#                         error_obj = error_json.get("error", {})
#                         if isinstance(error_obj, dict):
#                             error_msg = error_obj.get("message", str(error_obj))
#                         else:
#                             error_msg = str(error_obj)
#                     else:
#                         error_msg = str(error_json)
#                 except Exception:
#                     error_msg = error_text[:500]
#
#                 logging.warning(f"[Anthropic] Token refresh failed (status {response.status_code}): {error_msg}")
#                 return TokenRefreshResult(success=False, error=error_msg)
#
#             token_response = response.json()
#             access_token = token_response.get("access_token")
#             new_refresh_token = token_response.get("refresh_token", refresh_token)
#
#             if not access_token:
#                 return TokenRefreshResult(success=False, error="No access token in refresh response")
#
#             # Calculate expires_at from expires_in if present
#             expires_at = token_response.get("expires_at")
#             if not expires_at and token_response.get("expires_in"):
#                 expires_at = int((time.time() + token_response["expires_in"]) * 1000)
#
#             user_profile = extract_user_profile_from_token_response(token_response)
#             oauth_info = _extract_oauth_info_from_token_response(token_response)
#
#             # Save refreshed credentials
#             save_oauth_token_response(token_response)
#
#             logging.info("[Anthropic] Successfully refreshed OAuth token")
#
#             return TokenRefreshResult(
#                 success=True,
#                 access_token=access_token,
#                 refresh_token=new_refresh_token,
#                 expires_at=expires_at,
#                 user_profile=user_profile,
#                 oauth_info=oauth_info,
#             )
#
#     except Exception as e:
#         logging.error(f"[Anthropic] Token refresh error: {e}")
#         return TokenRefreshResult(success=False, error=str(e))


def _check_system_env_vars():
    """Check system environment variables for credentials."""
    api_key = os.environ.get(ANTHROPIC_API_KEY_ENV_VAR)
    oauth_token = os.environ.get(CLAUDE_CODE_OAUTH_TOKEN_NAME)
    return api_key, oauth_token


def _check_credentials_file():
    """Check Claude Code credentials file for OAuth tokens."""
    creds = read_credentials()
    if not creds:
        logging.info("[Claude Auth Debug] _check_credentials_file: read_credentials() returned None/empty")
        return None, None, None, None

    # Log top-level keys so we can see the credential structure
    logging.info(f"[Claude Auth Debug] _check_credentials_file: top-level keys={list(creds.keys())}")

    oauth_creds = creds.get("claudeAiOauth", creds)
    logging.info(f"[Claude Auth Debug] _check_credentials_file: oauth_creds keys={list(oauth_creds.keys())}")

    oauth_token = oauth_creds.get("accessToken") or oauth_creds.get("access_token")
    refresh_token = oauth_creds.get("refreshToken") or oauth_creds.get("refresh_token")

    logging.info(
        f"[Claude Auth Debug] _check_credentials_file: "
        f"has_accessToken={bool(oauth_creds.get('accessToken'))}, "
        f"has_access_token={bool(oauth_creds.get('access_token'))}, "
        f"has_refreshToken={bool(oauth_creds.get('refreshToken'))}, "
        f"has_refresh_token={bool(oauth_creds.get('refresh_token'))}, "
        f"resolved: has_oauth_token={bool(oauth_token)}, has_refresh_token={bool(refresh_token)}"
    )

    oauth_info = None
    user_profile = None

    if oauth_token:
        expires_at = oauth_creds.get("expiresAt") or oauth_creds.get("expires_at")
        is_expired = False
        if expires_at:
            current_time_ms = int(time.time() * 1000)
            is_expired = expires_at < current_time_ms
            logging.info(
                f"[Claude Auth Debug] _check_credentials_file: "
                f"expires_at={expires_at}, current_time_ms={current_time_ms}, "
                f"diff_seconds={(expires_at - current_time_ms) / 1000:.0f}s, "
                f"is_expired={is_expired}"
            )
        else:
            logging.info("[Claude Auth Debug] _check_credentials_file: no expires_at found in credentials")

        oauth_info = OAuthInfo(
            subscription_type=oauth_creds.get("subscriptionType") or oauth_creds.get("subscription_type"),
            rate_limit_tier=oauth_creds.get("rateLimitTier") or oauth_creds.get("rate_limit_tier"),
            scopes=oauth_creds.get("scopes", []),
            expires_at=expires_at,
            is_expired=is_expired,
        )

        account_email = oauth_creds.get("accountEmail")
        org_name = oauth_creds.get("organizationName")
        if account_email or org_name:
            user_profile = UserProfileInfo(
                email=account_email,
                account_uuid=oauth_creds.get("accountUuid"),
                organization_name=org_name,
                organization_uuid=oauth_creds.get("organizationUuid"),
            )
    else:
        logging.info("[Claude Auth Debug] _check_credentials_file: no OAuth token found in credentials")

    return oauth_token, refresh_token, oauth_info, user_profile


async def detect_claude_code_auth() -> ClaudeCodeAuthStatus:
    """Detect Claude Code authentication from multiple sources.

    Checks what Claude CLI will actually use (matching CLI's priority):
    1. System env vars (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN) - for CI/CD
    2. Credentials file (~/.claude/.credentials.json) for OAuth
    3. Settings file (~/.claude/settings.json) for API key
    """
    try:
        # Step 1: Check system environment variables
        api_key, oauth_token = _check_system_env_vars()
        logging.info(
            f"[Claude Auth] Step 1 - System env vars: has_api_key={bool(api_key)}, has_oauth_token={bool(oauth_token)}"
        )

        if oauth_token:
            logging.info("[Claude Auth] Step 1 - Found OAuth token in system env")
            return ClaudeCodeAuthStatus(
                is_authenticated=True,
                auth_method=ClaudeCodeAuthMethod.OAUTH,
                oauth_info=OAuthInfo(),
                credentials_source="system_environment",
            )

        if api_key:
            # Before returning API key, check if credentials file has valid OAuth
            file_oauth_token, file_refresh_token, file_oauth_info, _ = _check_credentials_file()
            if file_oauth_token:
                is_valid_oauth = False
                if file_oauth_info:
                    if not file_oauth_info.is_expired:
                        is_valid_oauth = True
                    elif file_refresh_token:
                        is_valid_oauth = True
                if is_valid_oauth:
                    logging.info("[Claude Auth] Step 1 - API key in env, but valid OAuth in creds file - deferring")
                    # Fall through to credentials file check
                    api_key = None  # Don't use env API key

            if api_key:
                logging.info("[Claude Auth] Step 1 - Found API key in system env")
                return ClaudeCodeAuthStatus(
                    is_authenticated=True,
                    auth_method=ClaudeCodeAuthMethod.API_KEY,
                    api_key_info=ApiKeyInfo(key_prefix=mask_api_key(api_key), source="system_environment"),
                    credentials_source="system_environment",
                )

        # Step 2: Check credentials file for OAuth
        file_oauth_token, file_refresh_token, file_oauth_info, file_user_profile = _check_credentials_file()
        logging.info(
            f"[Claude Auth] Step 2 - Credentials file: "
            f"has_oauth_token={bool(file_oauth_token)}, has_refresh_token={bool(file_refresh_token)}"
        )

        if file_oauth_token:
            if file_oauth_info and file_oauth_info.is_expired:
                if file_refresh_token:
                    # Token expired but refresh token exists — Claude Code will
                    # refresh lazily on its next API call. Trust that the user
                    # is authenticated and don't show the OAuth modal.
                    logging.info(
                        f"[Claude Auth] Step 2 - Token expired but refresh token present → "
                        f"reporting is_authenticated=True (CC will refresh lazily). "
                        f"expires_at={file_oauth_info.expires_at}, "
                        f"subscription_type={file_oauth_info.subscription_type}"
                    )
                    return ClaudeCodeAuthStatus(
                        is_authenticated=True,
                        auth_method=ClaudeCodeAuthMethod.OAUTH,
                        oauth_info=file_oauth_info,
                        user_profile=file_user_profile,
                        credentials_source="credentials_file",
                    )

                # Token expired and NO refresh token — user must re-authenticate.
                logging.warning(
                    f"[Claude Auth] Step 2 - Token EXPIRED, no refresh token → "
                    f"returning is_authenticated=False. "
                    f"expires_at={file_oauth_info.expires_at}, "
                    f"subscription_type={file_oauth_info.subscription_type}, "
                    f"user_email={file_user_profile.email if file_user_profile else 'N/A'}. "
                    f"User must re-authenticate."
                )
                return ClaudeCodeAuthStatus(
                    is_authenticated=False,
                    auth_method=ClaudeCodeAuthMethod.NONE,
                    oauth_info=file_oauth_info,
                    user_profile=file_user_profile,
                    error="Token expired and no refresh token. Please re-authenticate.",
                )

            logging.info("[Claude Auth] Step 2 - Found valid OAuth token in credentials file")
            return ClaudeCodeAuthStatus(
                is_authenticated=True,
                auth_method=ClaudeCodeAuthMethod.OAUTH,
                oauth_info=file_oauth_info or OAuthInfo(),
                user_profile=file_user_profile,
                credentials_source="credentials_file",
            )

        # Step 3: Check settings.json for API key
        settings_path = get_user_home_path() / ".claude" / "settings.json"
        if settings_path.exists():
            try:
                with open(settings_path, "r", encoding="utf-8") as f:
                    settings = json.load(f)
                settings_api_key = settings.get("env", {}).get("ANTHROPIC_API_KEY")
                if settings_api_key:
                    logging.info("[Claude Auth] Step 3 - Found API key in settings.json")
                    return ClaudeCodeAuthStatus(
                        is_authenticated=True,
                        auth_method=ClaudeCodeAuthMethod.API_KEY,
                        api_key_info=ApiKeyInfo(key_prefix=mask_api_key(settings_api_key), source="settings.json"),
                        credentials_source="settings.json",
                    )
            except Exception as e:
                logging.warning(f"[Claude Auth] Step 3 - Failed to read settings.json: {e}")

        # No authentication found
        logging.info(
            "[Claude Auth] CONCLUSION: No authentication found in any source. "
            "Checked: (1) env vars ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN, "
            f"(2) credentials store (platform={platform.system().lower()}), "
            f"(3) settings.json at {settings_path}. "
            "All returned empty. → is_authenticated=False, auth_method=NONE"
        )
        return ClaudeCodeAuthStatus(
            is_authenticated=False,
            auth_method=ClaudeCodeAuthMethod.NONE,
        )

    except Exception as e:
        logging.error(f"Error detecting Claude Code auth: {e}")
        return ClaudeCodeAuthStatus(
            is_authenticated=False,
            auth_method=ClaudeCodeAuthMethod.NONE,
            error=str(e),
        )
