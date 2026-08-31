"""Inbound mail drives the agent that owns the mailbox.

The projection turns an ingested message into a conversation and stops there.
This is the other half: when the mailbox belongs to an agent, and the sender is
allowed to drive it, the message becomes a turn and the answer goes back out the
same thread.

**One process per conversation, not per message.** The thread IS the session —
that is what makes an email exchange a conversation rather than a series of
strangers. `_reuse_or_spawn_headless` is the existing find-or-make for exactly
this ("share one process per conversation — no proliferation"), and continuity
across days and restarts is already solved by the process's own `session_id`
plus the vendor's on-disk transcript. Nothing here has to remember anything.

**The allowlist is also the loop breaker.** The hub files an agent's sent copy
in the same mailbox, so the next poll ingests the agent's own reply and fires
this handler again. An agent's address is not in its own allowlist, so the reply
is ignored — and because that is load-bearing rather than incidental, the self
check below states it a second time and does not rely on the coincidence.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


async def _agent_for(source) -> Optional[Any]:
    """The agent whose mailbox this source is, or None if it is not one."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.inbox.projection import agent_id_of  # noqa: PLC0415

    agent_id = agent_id_of(source)
    return await Agent.get_by_id(agent_id) if agent_id else None


async def _workdir_for(agent) -> str:
    """Where the turn runs. The agent's project, else the instance data dir.

    A turn needs somewhere to be; it does not need somewhere specific. Falling
    back rather than refusing keeps a project-less agent answerable. The mount
    field is the one `execute_prompt` uses for the same question — a `Project`
    has no `cwd` attribute, so probing for one only ever returns the fallback.
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    project = await Project.get_by_id(agent.project_id) if agent.project_id else None
    mount = str(getattr(project, "fs_storage_mount_path", "") or "") if project else ""
    return mount or str(get_instance_settings().instance_dir)


async def _conversation_id_for(item, source) -> Optional[str]:
    """The conversation this message landed in.

    READ from the thread rather than re-derived. The thread is resolved by its
    natural key (`find_existing`), and once it exists its `conversation_id` is
    authoritative, because merging two threads repoints it — a second
    derivation here would answer with the pre-merge id and split the session.
    """
    from flow_sdk.builtin.message_thread import MessageThread  # noqa: PLC0415
    from flow_sdk.inbox.projection import channel_of, thread_key_for  # noqa: PLC0415

    thread = await MessageThread.find_existing(
        channel_of(source), thread_key_for(item, item.name or "")
    )
    return str(getattr(thread, "conversation_id", "") or "") or None


def _is_own_outgoing(item, source) -> bool:
    """Did WE write this? The loop guard.

    Belt and braces with the allowlist: an agent's own address should never be
    a permitted sender, but "should never" is not a mechanism, and the failure
    mode here is an agent answering itself forever.
    """
    from flow_sdk.inbox.projection import is_self_address  # noqa: PLC0415

    return is_self_address(source, item.author_external_id or "")


async def handle_inbound(item) -> bool:
    """Run the agent on one inbound message. Returns whether a turn ran.

    Returns rather than raises for every refusal: not-for-an-agent, not-allowed
    and already-ours are all ordinary outcomes, not errors, and the message has
    already been ingested and projected either way — the owner can see it.
    """
    from flow_sdk.app.actions.execute_prompt import (  # noqa: PLC0415
        _capture_assistant_reply,
        _reuse_or_spawn_headless,
    )
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
    from flow_sdk.inbox.outbound import dispatch_channel_reply  # noqa: PLC0415

    source = await DataSource.get_one({"id": item.data_source_id})
    if source is None:
        return False

    # The loop guard first: it is pure string work, and the hub files every
    # reply this agent sends back into the same mailbox — so without this order
    # every outgoing message pays an Agent row read on its way to being ignored.
    if _is_own_outgoing(item, source):
        return False
    agent = await _agent_for(source)
    if agent is None:
        return False
    if not agent.may_email(item.author_external_id or ""):
        logger.info("[agent-mail] ignoring mail to %s from unlisted sender", agent.name or agent.id)
        return False

    body = (item.body or "").strip()
    if not body:
        return False

    conversation_id = await _conversation_id_for(item, source)
    if not conversation_id:
        logger.warning("[agent-mail] no conversation for source_item %s", item.id)
        return False

    workdir = await _workdir_for(agent)
    ap = await _reuse_or_spawn_headless(str(TypeId(type="conversation", id=conversation_id)), workdir)
    await ap.prompt(body)
    reply = await _capture_assistant_reply(ap)
    if not reply:
        logger.info("[agent-mail] turn produced no reply for %s", conversation_id)
        return False

    # Body and recipients only. The reply path deliberately passes NO headers:
    # outbound headers reach the provider verbatim (no allowlist, no CRLF
    # stripping — a known, open hub finding), so anything a correspondent could
    # influence must not be able to reach them.
    # A refusal here is REPORTED, not swallowed. `dispatch_channel_reply`
    # answers with a fail response rather than raising when it cannot work out
    # who to answer, and the turn has already run at that point — so dropping
    # the result silently spends a real turn and loses the answer with no trace,
    # which reads downstream as "the agent never replied".
    outcome = await dispatch_channel_reply(conversation_id, text=reply)
    if getattr(outcome, "status", "") == "FAIL":
        logger.warning(
            "[agent-mail] reply for %s could not be dispatched: %s",
            conversation_id,
            getattr(outcome, "message", "") or "unknown reason",
        )
        return False
    return True


async def _on_item(event) -> None:
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

    entity_id = str((event.data or {}).get("entity_id") or "")
    if not entity_id:
        return
    try:
        item = await SourceItem.get_one({"id": entity_id})
        if item is not None:
            await handle_inbound(item)
    except Exception:  # noqa: BLE001 — never fail the ingest that triggered us
        logger.exception("[agent-mail] inbound handling failed for %s", entity_id)


def subscribe() -> Callable[[], None]:
    """Wire the bus to `handle_inbound`. Returns the unsubscriber.

    A second subscriber beside the projection rather than a branch inside it:
    projecting a message and answering it are different jobs with different
    failure modes, and a crash in the agent turn must not stop mail becoming a
    conversation.
    """
    from flow_sdk.tags import on_tag  # noqa: PLC0415

    # `inbox.*.message.projected`, NOT `ingest.*.item.created`. The trigger for
    # a turn is not "mail was ingested" but "mail became a conversation": this
    # handler reads the thread's `conversation_id`, which the projection writes.
    # Subscribing to the ingest tag put both handlers on the same emit, and Law
    # 3 detaches each one — so this raced the projection's write, read no
    # thread, and dropped the mail with a warning nobody sees.
    return on_tag("inbox.*.message.projected", _on_item)
