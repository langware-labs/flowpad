"""Vendor CLI login-state probes — pure stdlib, zero flow_sdk imports.

Each worker CLI answers "am I logged in?" differently:

- claude: ``claude auth status`` prints JSON (exit code is 0 either way, so
  the decision is made on the ``loggedIn`` field, never the return code).
- codex: ``codex login status`` — exit 0 = logged in, nonzero = logged out.
- copilot: has NO status subcommand. Best-effort heuristic only: an auth
  token in the environment, else a past-login marker in
  ``~/.copilot/config.json``. The real token lives in the OS credential
  store, so this path can never claim ``verified``.

The module is deliberately dependency-light so it can be exercised inside a
bare container by file path (``importlib.util.spec_from_file_location``)
without installing flow_sdk — keep it free of flow_sdk imports.

Probes are synchronous (drivers wrap them in ``asyncio.to_thread``), never
raise, and map "couldn't check" (timeout, exec error, unparseable output) to
``UNKNOWN`` — never to ``LOGGED_OUT``.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping

# Hard cap per probe subprocess — same budget as CliCapabilityRunner.test.
PROBE_TIMEOUT_SECONDS = 5.0

# Env vars copilot honors for headless auth, in its documented precedence.
COPILOT_TOKEN_ENV_VARS = ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN")


class WorkerAuthStatus(str, Enum):
    NOT_INSTALLED = "not_installed"
    LOGGED_IN = "logged_in"
    LOGGED_OUT = "logged_out"
    UNKNOWN = "unknown"


class DeviceLoginState(str, Enum):
    IDLE = "idle"
    STARTING = "starting"
    AWAITING_USER = "awaiting_user"
    AUTHENTICATED = "authenticated"
    ERROR = "error"


@dataclass(frozen=True)
class DeviceLoginSpec:
    """How one vendor's CLI runs its link(+code) login flow.

    codex/copilot are RFC-8628 device flows: the CLI prints a verification
    URL + one-time code and polls to completion. claude is auth-code+PKCE:
    the browser shows a code the user pastes BACK into the CLI —
    ``accepts_code_paste`` captures that difference.
    """

    login_argv: tuple[str, ...]
    url_re: "re.Pattern[str]"
    code_re: "re.Pattern[str] | None"  # None ⇒ vendor shows the code in the browser
    accepts_code_paste: bool


# Regexes for lifting login artifacts out of raw PTY output.
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\r\x08]")
# OSC 8 terminal hyperlink: \x1b]8;;<target>\x07 — claude prints its OAuth URL
# as the TARGET (the visible text is a wrapped rendering), so lift targets out
# BEFORE generic OSC stripping deletes them.
OSC8_RE = re.compile(r"\x1b\]8;;([^\x07\x1b]+)(?:\x07|\x1b\\)")
# Continuation lines must be WHOLE lines of URL characters — the lookahead
# stops a following prose line ("Paste code here …") from being glued on.
_WRAPPED_URL_RE = re.compile(r"(https://\S+)((?:\n[A-Za-z0-9%&=+_.~/:?\-]+(?=\n|$))+)")

# Interactive questions a login CLI may ask mid-flow (invisible to any UI) —
# answered automatically. Containers/headless hosts have no OS keychain, so
# plaintext storage is the only option and "yes" is what the user would say.
AUTO_ANSWERS: list[tuple["re.Pattern[str]", str]] = [
    (re.compile(r"Store token in plaintext config file\? \(y/N\)"), "y\r"),
    # gh auth login --web pauses on Enter before trying to open the browser.
    # The device URL + code are already printed (and scraped) by then; a failed
    # browser-open on a headless host is harmless.
    (re.compile(r"Press Enter to open .* in your browser"), "\r"),
]


def clean_pty_output(raw: str) -> str:
    """Raw PTY stream → plain text with OSC-8 link targets preserved."""
    return ANSI_RE.sub("", OSC8_RE.sub(r" \1 ", raw))


def scrape_device_login(clean_text: str, spec: DeviceLoginSpec) -> tuple[str | None, str | None]:
    """(url, code) scraped from ALREADY-CLEANED login output.

    Pure — feed it the whole cleaned stream each time (escape sequences can
    split across read chunks, so incremental cleaning corrupts). Callers pass
    ``clean_pty_output(raw)``. CLIs hard-wrap long OAuth URLs; wrapped URL
    lines are glued back together.
    """
    unwrapped = _WRAPPED_URL_RE.sub(lambda m: m.group(1) + m.group(2).replace("\n", ""), clean_text)
    url_match = spec.url_re.search(unwrapped)
    url = url_match.group(1).rstrip(".,)") if url_match else None
    code = None
    if spec.code_re is not None:
        code_match = spec.code_re.search(clean_text)
        code = code_match.group(1) if code_match else None
    return url, code


def find_auto_answer(clean_text: str, answered: set[int]) -> tuple[int, str] | None:
    """First not-yet-answered AUTO_ANSWERS prompt in ALREADY-CLEANED output."""
    for i, (pattern, answer) in enumerate(AUTO_ANSWERS):
        if i not in answered and pattern.search(clean_text):
            return i, answer
    return None


@dataclass
class WorkerAuthResult:
    status: WorkerAuthStatus
    # True only when the vendor CLI itself confirmed the state. Copilot's
    # heuristic (env token / config marker) is never verified.
    verified: bool = False
    message: str = ""
    details: dict[str, Any] = field(default_factory=dict)
    # How the harness authenticates: "device" (vendor device login — the default
    # for every native probe) or "api" (a stored LLM-provider key).
    auth_mode: str = "device"
    # WHO is signed in, and on WHAT — normalized here because only the probe
    # knows its vendor's JSON. `details` keeps the vendor's own keys for anyone
    # who wants them; a consumer that just wants to show the account reads
    # these, and does not learn that claude spells a plan `subscriptionType`.
    # Empty whenever the vendor does not say, which is every vendor but claude.
    identity: str = ""
    plan: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "verified": self.verified,
            "message": self.message,
            "details": self.details,
            "auth_mode": self.auth_mode,
            "identity": self.identity,
            "plan": self.plan,
        }


def _run_cli(
    argv: list[str],
    env: Mapping[str, str],
    timeout: float,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=dict(env),
    )


def probe_claude_auth(
    executable: str,
    env: Mapping[str, str],
    timeout: float = PROBE_TIMEOUT_SECONDS,
) -> WorkerAuthResult:
    """``claude auth status`` — decide on the JSON ``loggedIn`` field only."""
    proc = _run_cli([executable, "auth", "status"], env, timeout)
    output = (proc.stdout or "").strip()
    try:
        parsed = json.loads(output)
    except (json.JSONDecodeError, ValueError):
        parsed = None
    if not isinstance(parsed, dict) or "loggedIn" not in parsed:
        # Old claude versions without the `auth` subcommand land here too
        # (nonzero rc, usage text on stderr).
        return WorkerAuthResult(
            status=WorkerAuthStatus.UNKNOWN,
            message=(output or (proc.stderr or "").strip())[:500],
            details={"returncode": proc.returncode},
        )
    if parsed["loggedIn"]:
        # NOT ``verified``. ``claude auth status`` reads the credential off disk
        # and never asks the server whether it still works — with
        # ``ANTHROPIC_BASE_URL`` pointed at a dead port it still answers
        # ``loggedIn: true``. So an expired, revoked or signed-out-elsewhere
        # credential reports "logged in" here while the very same binary answers
        # a real turn with "Not logged in · Please run /login". Presence is all
        # this proves, and callers must weigh it as such — same class as
        # copilot's heuristic below, which has always said so.
        return WorkerAuthResult(
            status=WorkerAuthStatus.LOGGED_IN,
            verified=False,
            message="claude CLI has stored credentials (not validated).",
            details={k: parsed[k] for k in ("email", "authMethod", "subscriptionType", "apiProvider") if k in parsed},
            identity=str(parsed.get("email") or ""),
            # NOT `authMethod`: that is the mechanism ("claude.ai"), and a column
            # meant to say which account you hold should not answer with how you
            # signed into it.
            plan=str(parsed.get("subscriptionType") or ""),
        )
    return WorkerAuthResult(
        status=WorkerAuthStatus.LOGGED_OUT,
        verified=True,
        message="claude CLI is not logged in.",
    )


def probe_codex_auth(
    executable: str,
    env: Mapping[str, str],
    timeout: float = PROBE_TIMEOUT_SECONDS,
) -> WorkerAuthResult:
    """``codex login status`` — exit 0 = logged in, nonzero = logged out."""
    proc = _run_cli([executable, "login", "status"], env, timeout)
    message = ((proc.stdout or "") + (proc.stderr or "")).strip()[:500]
    if proc.returncode == 0:
        return WorkerAuthResult(
            status=WorkerAuthStatus.LOGGED_IN,
            verified=True,
            message=message or "codex CLI has stored credentials.",
        )
    return WorkerAuthResult(
        status=WorkerAuthStatus.LOGGED_OUT,
        verified=True,
        message=message or "codex CLI is not logged in.",
        details={"returncode": proc.returncode},
    )


def probe_copilot_auth(
    env: Mapping[str, str],
    home: Path,
    copilot_home: Path | None = None,
) -> WorkerAuthResult:
    """Heuristic only — copilot has no status subcommand.

    Env token or a ``loggedInUsers`` marker in copilot's ``config.json``
    proves a *past* login at best (the token itself lives in the OS
    credential store), so the result is never ``verified``.

    ``copilot_home`` is the instance-resolved config dir (``FLOWPAD_COPILOT_HOME``
    redirects it); callers that do not resolve instance settings fall back to
    ``<home>/.copilot``.
    """
    for var in COPILOT_TOKEN_ENV_VARS:
        if env.get(var):
            return WorkerAuthResult(
                status=WorkerAuthStatus.LOGGED_IN,
                message=f"copilot auth token present in ${var} (not validated).",
                details={"source": f"env:{var}"},
            )
    config_path = (copilot_home or home / ".copilot") / "config.json"
    try:
        raw = config_path.read_text(encoding="utf-8")
    except OSError:
        return WorkerAuthResult(
            status=WorkerAuthStatus.LOGGED_OUT,
            message="copilot CLI has no login marker (no env token, no config.json).",
        )
    # The CLI writes JSONC — full-line // comments above the JSON body.
    body = "\n".join(line for line in raw.splitlines() if not line.lstrip().startswith("//"))
    try:
        config = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return WorkerAuthResult(
            status=WorkerAuthStatus.UNKNOWN,
            message=f"copilot config.json at {config_path} is not valid JSON.",
        )
    users = config.get("loggedInUsers") if isinstance(config, dict) else None
    if isinstance(users, list) and users:
        logins = [u.get("login") for u in users if isinstance(u, dict) and u.get("login")]
        return WorkerAuthResult(
            status=WorkerAuthStatus.LOGGED_IN,
            message="copilot config.json records a past login (token not validated).",
            details={"source": "config", "users": logins},
        )
    return WorkerAuthResult(
        status=WorkerAuthStatus.LOGGED_OUT,
        message="copilot config.json has no logged-in users.",
    )


def probe_worker_auth(
    worker_type: str,
    executable_path: str | None,
    env: Mapping[str, str],
    home: Path,
    copilot_home: Path | None = None,
) -> WorkerAuthResult:
    """Classify one worker CLI's login state. Never raises.

    ``executable_path`` is the disk-verified absolute path of the CLI (None ⇔
    not installed); ``env`` is the spawn env the worker would actually run
    with (discovered bin folder first on PATH, so ``#!/usr/bin/env node``
    shebangs resolve). ``copilot_home`` overrides the copilot config dir for
    callers that can resolve instance settings (``<home>/.copilot`` otherwise).
    """
    if executable_path is None:
        return WorkerAuthResult(
            status=WorkerAuthStatus.NOT_INSTALLED,
            verified=True,
            message=f"{worker_type} CLI is not installed.",
        )
    try:
        if worker_type == "claude":
            return probe_claude_auth(executable_path, env)
        if worker_type == "codex":
            return probe_codex_auth(executable_path, env)
        if worker_type == "copilot":
            return probe_copilot_auth(env, home, copilot_home)
        return WorkerAuthResult(
            status=WorkerAuthStatus.UNKNOWN,
            message=f"No auth probe defined for worker type {worker_type!r}.",
        )
    except subprocess.TimeoutExpired:
        return WorkerAuthResult(
            status=WorkerAuthStatus.UNKNOWN,
            message=f"{worker_type} auth probe timed out after {PROBE_TIMEOUT_SECONDS}s.",
            details={"error": "timeout"},
        )
    except OSError as exc:
        return WorkerAuthResult(
            status=WorkerAuthStatus.UNKNOWN,
            message=f"{worker_type} auth probe failed to execute: {exc}",
            details={"error": str(exc)},
        )
