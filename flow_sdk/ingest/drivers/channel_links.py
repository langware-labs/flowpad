"""How to address a record in each channel's own UI.

Provider knowledge, so it lives here with the drivers (docs/glossary.md:
"Provider-specific knowledge lives only in `flow_sdk/ingest/drivers/`") even
though its consumer is the inbox projection.

Only channels whose connector gives us NO link need an entry. `rss` and
`hackernews` set `IngestItem.permalink` at fetch time and never reach this.
Gmail does need one: it arrives through the agent transport, where the WORKER
constructs the items via `flow record create` — so there is no driver-side
construction site to set it at, and the alternative is asking a model to
compose the URL. That is actively dangerous, because `permalink` is a
DIGESTED field: a model that formats it differently on the next poll rewrites
the entire corpus. A formula here is stable by construction.

Formulas only, never a fetch.
"""
from __future__ import annotations

#: channel → template. `{thread}` falls back to `{id}` when the provider has
#: no separate thread handle.
_PERMALINK: dict[str, str] = {
    "gmail": "https://mail.google.com/mail/u/0/#all/{thread}",
}


def permalink_for(channel: str, external_id: str, thread_key: str = "") -> str:
    """A link into the channel's own UI, or "" when we cannot address it.

    An empty string is the honest answer for an unknown channel — the badge
    renders inert rather than as a link that 404s.
    """
    template = _PERMALINK.get((channel or "").strip().lower())
    if not template or not (external_id or thread_key):
        return ""
    return template.format(thread=thread_key or external_id, id=external_id)
