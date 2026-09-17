""""Inbox" is not a name here — it meant three different things.

A channel has its own inbox folder (IMAP ``INBOX``, AgentMail's ``/v0/inboxes``); an Agent has a
hub-allocated email address; Flowpad has a merged view of every message source an owner holds. The
one word named all three, so ``agent.inbox`` was the mailbox while ``/dock/agent/<id>/inbox`` was
every channel. They are now ``AgentMailbox`` and ``StreamInbox``, and this test keeps it that way.

Every file (tracked and untracked) is checked by PATH and CONTENT, camelCase included. The compound
``stream inbox`` forms are the name. What remains is somebody else's word, and each kind is removed
from a line before the line is judged — never the whole line — so a vendor token cannot hide a bare
``inbox`` beside it:

* ``VENDOR_TOKENS`` — vocabulary that means the same thing wherever it appears;
* ``EXEMPT_FILES`` — files that speak a vendor's language throughout;
* ``PHRASES`` — plain English for a person's own mailbox, pinned to the file that says it.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(30)  # do not increase without approval

REPO = Path(__file__).resolve().parents[2]

#: Generated or vendored trees: regenerate them, don't carve them out.
EXCLUDED = re.compile(
    r"^(flow_sdk/server/static/|ui/tests/manual_regression/_results/|\.claude/worktrees/)"
    r"|\.tsbuildinfo$|^ui/src/locales/[^/]+/messages\.js$"
)

#: The compound forms that ARE the name ("stream" and "inbox" may wrap across a comment line).
NAME = re.compile(r"stream(?:[ \t_-]|[ \t]*\n[ \t]*(?:#|//|\*|--)?[ \t]*)?inbox", re.IGNORECASE)

VENDOR_TOKENS = re.compile("|".join((
    r"provider_inbox_id",                                  # the provider's own id for its inbox
    r"AGENTMAIL_PROBE_INBOX",                              # an AgentMail inbox used by the live probe
    r"\bsignedInBox\b",                                  # a signed-in sandbox box, not an inbox
    r"\bINBOX\b",                                          # the IMAP folder / segment key
    r"/v0/inboxes|%2Finboxes|/inboxes\b",                  # AgentMail's API routes
    r"[\"'`]{1,2}inbox_id[\"'`]{1,2}|\binbox_id=",         # AgentMail's field
    r"AgentMail inbox|Inbox limit exceeded|inbox limit",   # AgentMail's own wording
    r"[\"']?inbox[\"']?\s*:\s*[\"'][^\"']*@agentmail\.to[\"']",  # the agentmail driver's `inbox` config key
    r"find_for_account\([\"']agentmail[\"'],\s*[\"']inbox[\"']",
    r"\bInbox\b(?=.*from ['\"]lucide-react['\"])|\bInbox as InboxIcon\b|\bInboxIcon\b|<Inbox\b",  # the lucide icon
    r"icon[\w\[\]:\s]*=\s*[\"']Inbox[\"']|lucide\.inbox",
)))

#: ``path regex -> why`` for files whose every mention is a vendor's word.
EXEMPT_FILES = {
    r"^flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/gmail/": "Gmail over IMAP: the INBOX folder and its helpers",
    r"^flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/agentmail/": "AgentMail's API: an inbox is its resource and `inbox` its config key",
    r"^tests/long_tests/test_(agentmail_roundtrip|blocks_email_workflow)\.py$": "live AgentMail legs create and delete the vendor's inboxes",
    r"^flow_sdk/server/icons/|^examples/icon-gallery/|^docs/icons(_map\.html|\.md)$": "the lucide icon set and its catalogs",
    r"^flow_sdk/system_projects/flowpad_assistant/migrations/0\.2\.26/": "a shipped historical migration",
    r"^tests/unit/test_no_bare_inbox_name\.py$": "this guard",
}

#: ``path regex -> phrases`` a file may say, each for the reason on its line.
PHRASES = {
    # the retired names, where they are retired
    r"^flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/cloud_email/(source|tests/test_cloud_email_source)\.py$": ["inbox_typeid"],
    r"^flow_sdk/server/app\.py$|^tests/unit/test_fs_store/test_entity_type_enum\.py$": ['"inbox_manager"'],
    r"^docs/glossary\.md$": ['"inboxes"', '"inbox" is not a name'],
    # the agentmail driver's `inbox` config key, named in prose
    r"^docs/snippets/data-sources\.md$": ["`inbox`"],
    r"^ui/tests/manual_regression/data-sources/credentialed_sources\.md(\.ts)?$": ["`inbox` field", "the inbox is account-bound"],
    # plain English for a person's own email inbox
    r"^flow_sdk/system_projects/flowpad_assistant/\.claude/agents/email_analyzer\.md$": ["the inbox you were asked for"],
    r"^flow_sdk/system_projects/flowpad_assistant/\.claude/agents/email_sender\.md$": ["someone's inbox", "fetch of the inbox"],
    r"^flow_sdk/system_projects/flowpad_assistant/\.claude/agents/email_summarizer\.md$": ["inbox summary", "gmail_inbox_summary"],
    r"^flow_sdk/system_projects/flowpad_assistant/agentic-assets/agent/emailer/system_prompt\.md$": ["someone's inbox"],
    r"^flow_sdk/system_projects/flowpad_assistant/\.claude/skills/connect-data-source/references/mapping\.md$": ["my inbox"],
    r"^flow_sdk/graph_workflow_manager/service_graph_workflows\.py$": ["inbox summary", "gmail_inbox_summary"],
    r"^tests/unit/test_runs_route\.py$": ["gmail_inbox_summary"],
    r"^tests/unit/test_agent_send\.py$": ["someone's inbox"],
    r"^tests/unit/test_agentic_process_turn_cleanup\.py$": ["today's inbox"],
    r"^tests/unit/test_cloud_origin_local_not_shared\.py$": ["#inbox/"],
    r"^docs/snippets/workflows\.md$": ["counterpart inbox"],
    r"^ui/src/components/llm-endpoints/share-endpoint\.ts$|^ui/tests/unit/share-endpoint\.test\.ts$": ["discovered in an inbox"],
    r"^ui/tests/e2e/agent-auto-launch/agent_auto_launch_persona\.spec\.ts$": ["on top of their inbox", "with your inbox", "/inbox|"],
}

_exempt = [re.compile(p) for p in EXEMPT_FILES]
_phrases = [(re.compile(p), phrases) for p, phrases in PHRASES.items()]


def _files(*args: str) -> list[str]:
    out = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=True).stdout
    return [f for f in out.splitlines() if not EXCLUDED.search(f) and not any(p.search(f) for p in _exempt)]


def _residue(path: str, text: str) -> str:
    """``text`` with the name, vendor tokens and the file's own phrases removed."""
    text = VENDOR_TOKENS.sub("", NAME.sub(lambda m: "\n" * m.group(0).count("\n"), text))
    for pattern, phrases in _phrases:
        if pattern.search(path):
            for phrase in phrases:
                text = text.replace(phrase, "")
    return text


def test_no_path_is_named_inbox():
    listed = _files("ls-files", "--cached", "--others", "--exclude-standard")
    offenders = [f for f in listed if "inbox" in _residue(f, f).lower()]
    assert not offenders, "rename by meaning (StreamInbox / AgentMailbox):\n" + "\n".join(offenders)


def test_no_file_uses_inbox_as_a_name():
    # A git pre-pass: few files mention the word at all, and reading every file in Python is most of a second.
    candidates = _files("grep", "-l", "-I", "-i", "--untracked", "inbox")
    offenders = []
    for f in candidates:
        try:
            text = (REPO / f).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        # Judged per line after removal, so a line number still points at the offender.
        for number, line in enumerate(_residue(f, text).splitlines(), 1):
            if "inbox" in line.lower():
                offenders.append(f"{f}:{number}: {line.strip()[:160]}")
    assert not offenders, (
        "'inbox' is not a name — say StreamInbox (Flowpad's merged view) or AgentMailbox (an agent's hub "
        "email address); a vendor's word goes in VENDOR_TOKENS / EXEMPT_FILES / PHRASES with its reason:\n"
        + "\n".join(offenders)
    )
