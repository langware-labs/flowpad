"""Inbound mail drives the agent that owns the mailbox.

The projection turns an ingested message into a conversation and stops there.
This is the other half: when the mailbox belongs to an agent, and the sender is
allowed to drive it, the message becomes a turn and the answer goes back out the
same thread.

**One process per conversation, not per message.** The thread IS the session —
that is what makes an email exchange a conversation rather than a series of
strangers. The process is created through the owning Agent's local Deployment,
so its system prompt, model, permissions and MCP servers reach every mail turn.
Continuity across days and restarts is solved by the process's own `session_id`
plus the vendor's on-disk transcript. Nothing here has to remember anything.

**The self check is the loop breaker.** The hub files an agent's sent copy in
the same mailbox, so the next poll ingests the agent's own reply and fires this
handler again. `_is_own_outgoing` — the source's stamped identity — is what
stops it. On a mailbox the allowlist happens to stop it too (an agent's address
is never on its own list), but an `open_inbound` channel (a help desk) admits
everyone, so the self check is the mechanism and not a belt on braces.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


async def _agent_for(owner) -> Optional[Any]:
    """The agent this source belongs to, or None when the owner is a user."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.inbox.projection import is_agent_owner  # noqa: PLC0415

    return await Agent.get_by_id(owner.id) if is_agent_owner(owner) else None


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


async def _conversation_id_for(item, source, owner) -> Optional[str]:
    """The conversation this message landed in.

    READ from the thread rather than re-derived. The thread is looked up by
    its natural key the way the projection wrote it (`find_thread`), and once
    it exists its `conversation_id` is authoritative, because merging two
    threads repoints it — a second derivation here would answer with the
    pre-merge id and split the session.
    """
    from flow_sdk.inbox.projection import channel_of, find_thread, thread_key_for  # noqa: PLC0415

    thread = await find_thread(channel_of(source), thread_key_for(item, item.name or ""), owner)
    return str(getattr(thread, "conversation_id", "") or "") or None


def _admits(source, author: str) -> bool:
    """Whether `author` may drive the agent through this source.

    Answered from the SOURCE alone — its status and its cached allowlist —
    not from an `EmailInbox` built out of it: that constructor needs a mailbox's
    `agent_id`, which a desk or a chat channel does not carry, and a gate that
    raises inside the bus handler reads as "the agent never answered".

    The allowlist is the rule (`sender_allowed`, the one fold). `open_inbound`
    is a driver's declaration that strangers are the point of its channel (a
    help desk), under which an EMPTY list admits everyone; a non-empty list
    restricts either way, and a paused source admits nobody either way.
    """
    from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415
    from flow_sdk.builtin.email_inbox import sender_allowed  # noqa: PLC0415
    from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

    if getattr(source, "status", None) != SourceStatus.ACTIVE.value:
        return False
    allowlist = [a for a in (getattr(source, "inbound_allowed_senders", None) or []) if str(a).strip()]
    if sender_allowed(allowlist, author):
        return True
    driver = get_driver(getattr(source, "provider", "") or "")
    return bool(driver is not None and driver.open_inbound and not allowlist)


def _is_own_outgoing(item, source) -> bool:
    """Did WE write this? The loop guard.

    Belt and braces with the allowlist: an agent's own address should never be
    a permitted sender, but "should never" is not a mechanism, and the failure
    mode here is an agent answering itself forever.
    """
    from flow_sdk.inbox.projection import is_self_address  # noqa: PLC0415

    return is_self_address(source, item.author_external_id or "")


async def _reuse_or_spawn_agent_process(agent, conversation_id: str, workdir: str):
    """One headless process for this Agent deployment and conversation.

    The generic conversation runner creates a bare ``AgenticProcess``. Mail is
    different: the mailbox belongs to a formal Agent, so creation must go
    through that Agent's Deployment to project its complete launch bundle.
    Including ``deployment_id`` in the lookup also prevents adopting a bare or
    differently configured process that happens to target the same thread.
    """
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.builtin.process_lifecycle import ProcessStatus  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    target = str(TypeId(type=EntityType.CONVERSATION.value, id=conversation_id))
    deployment = await agent.local_deployment()
    existing = await AgenticProcess.get_all(
        {
            "match": {
                "target_typeid_str": target,
                "deployment_id": deployment.id,
            },
            "order_by": {"created_date": "desc"},
        }
    )
    process = next(
        (
            candidate
            for candidate in existing
            if str(getattr(candidate, "status", "")) != ProcessStatus.FAILED.value
        ),
        None,
    )
    if process is not None:
        if getattr(process, "shell_id", None):
            try:
                await process.exit()
            except Exception:  # noqa: BLE001 — stale shells do not break reuse
                pass
        changed = False
        if process.workdir != workdir:
            process.workdir = workdir
            changed = True
        if process.visible is not False:
            process.visible = False
            changed = True
        if process.pty_mode is not False:
            process.pty_mode = False
            changed = True
        if changed:
            await process.save()
        return process

    process = await agent.create_process(
        "",
        deployment=deployment,
        target_typeid_str=target,
        workdir=workdir,
        visible=False,
        pty_mode=False,
    )
    await process.save()
    return process


async def handle_inbound(item) -> bool:
    """Run the agent on one inbound message. Returns whether a turn ran.

    Returns rather than raises for every refusal: not-for-an-agent, not-allowed
    and already-ours are all ordinary outcomes, not errors, and the message has
    already been ingested and projected either way — the owner can see it.
    """
    from flow_sdk.app.actions.execute_prompt import _capture_assistant_reply  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.inbox.outbound import dispatch_channel_reply  # noqa: PLC0415
    from flow_sdk.inbox.projection import owner_of  # noqa: PLC0415
    from flow_sdk.responses.response import ApiFailResponse  # noqa: PLC0415

    source = await DataSource.get_one({"id": item.data_source_id})
    if source is None:
        return False

    # The loop guard first: it is pure string work, and the hub files every
    # reply this agent sends back into the same mailbox — so without this order
    # every outgoing message pays an Agent row read on its way to being ignored.
    if _is_own_outgoing(item, source):
        return False
    owner = await owner_of(source)
    agent = await _agent_for(owner)
    if agent is None:
        return False
    # The gate answers from the source alone — the row carries its status and
    # the cached allowlist — so this per-message path never touches the Hub.
    if not _admits(source, item.author_external_id or ""):
        logger.info("[agent-mail] ignoring mail to %s from unlisted sender", agent.name or agent.id)
        return False

    body = (item.body or "").strip()
    if not body:
        return False

    conversation_id = await _conversation_id_for(item, source, owner)
    if not conversation_id:
        logger.warning("[agent-mail] no conversation for source_item %s", item.id)
        return False

    workdir = await _workdir_for(agent)
    ap = await _reuse_or_spawn_agent_process(agent, conversation_id, workdir)
    prompt_result = await ap.prompt(body)
    if isinstance(prompt_result, ApiFailResponse):
        logger.warning(
            "[agent-mail] prompt for %s was refused: %s",
            conversation_id,
            prompt_result.message or "unknown reason",
        )
        return False
    reply = await _capture_assistant_reply(ap)
    if not reply:
        logger.info("[agent-mail] turn produced no reply for %s", conversation_id)
        return False

    # Body and recipients only. The reply path deliberately passes NO headers:
    # a correspondent's input must not influence transport metadata.
    # A refusal here is REPORTED, not swallowed. `dispatch_channel_reply`
    # answers with a fail response rather than raising when it cannot work out
    # who to answer, and the turn has already run at that point — so dropping
    # the result silently spends a real turn and loses the answer with no trace,
    # which reads downstream as "the agent never replied".
    outcome = await dispatch_channel_reply(conversation_id, text=reply, source_id=source.id)
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
