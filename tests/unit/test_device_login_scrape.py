"""Device-login scraper — pure-function tests over real PTY captures."""

from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import (
    clean_pty_output,
    find_auto_answer,
    scrape_device_login,
)


def _scrape(raw, spec):
    return scrape_device_login(clean_pty_output(raw), spec)
from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import ClaudeDriver
from flow_sdk.builtin.agentic_process.cli_drivers.codex.driver import CodexDriver
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.driver import CopilotDriver

# Verbatim shapes captured from real CLIs in the docker POC (2026-07).
CODEX_CAPTURE = (
    "Follow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n"
    "1. Open this link in your browser and sign in to your account\r\n"
    "   https://auth.openai.com/codex/device\r\n\r\n"
    "2. Enter this one-time code (expires in 15 minutes)\r\n"
    "   A3YN-3DZJ9\r\n"
)
COPILOT_CAPTURE = (
    "To authenticate, visit https://github.com/login/device and enter code 0B67-E693\r\n"
    "Waiting for authorization...\r\n"
)
# claude publishes the URL as an OSC-8 hyperlink target; the visible text wraps.
CLAUDE_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=RlTQIPis"
CLAUDE_CAPTURE = (
    "Opening browser to sign in…\r\n"
    f"If the browser didn't open, visit: \x1b]8;;{CLAUDE_URL}\x07visible-text\x1b]8;;\x07\r\n"
    "Paste code here if prompted >"
)


def test_codex_scrape():
    url, code = _scrape(CODEX_CAPTURE, CodexDriver.device_login_spec)
    assert url == "https://auth.openai.com/codex/device"
    assert code == "A3YN-3DZJ9"


def test_copilot_scrape():
    url, code = _scrape(COPILOT_CAPTURE, CopilotDriver.device_login_spec)
    assert url == "https://github.com/login/device"
    assert code == "0B67-E693"


def test_claude_scrape_osc8_url_no_code():
    url, code = _scrape(CLAUDE_CAPTURE, ClaudeDriver.device_login_spec)
    assert url == CLAUDE_URL
    assert code is None
    assert ClaudeDriver.device_login_spec.accepts_code_paste


def test_claude_scrape_rejoins_hard_wrapped_url():
    wrapped = "visit: https://claude.com/cai/oauth/authorize?code=true&client\n_id=9d1c250a&state=abc\nPaste code here if prompted >"
    url, _ = _scrape(wrapped, ClaudeDriver.device_login_spec)
    assert url == "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=abc"


def test_auto_answer_keychain_once():
    raw = "Waiting...\r\nSystem keychain unavailable. Store token in plaintext config file? (y/N)"
    answered: set[int] = set()
    hit = find_auto_answer(clean_pty_output(raw), answered)
    assert hit is not None and hit[1] == "y\r"
    answered.add(hit[0])
    assert find_auto_answer(clean_pty_output(raw), answered) is None


def test_incomplete_output_scrapes_nothing():
    url, code = _scrape("Welcome to Codex\r\n1. Open this link", CodexDriver.device_login_spec)
    assert url is None and code is None
