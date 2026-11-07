"""RemoteWorkerSession / PromptCompletion invariants.

Covers the two things the host/guest execution refactor must guarantee without a
worker or DB: (1) host/guest role derivation, and (2) the loop-break — a
``prompt_completion`` attachment must NOT count as a runnable prompt, so a host's
reply can never re-trigger a run on the guest (no Claude↔Claude loop).
"""
from __future__ import annotations

from flow_sdk.builtin.flow_message import Attachment, AttachmentType
from flow_sdk.builtin.prompt_completion import PromptCompletion
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession


def test_host_guest_roles():
    rws = RemoteWorkerSession(host_user_id="host-1", guest_user_id="guest-1", conversation_id="c1")
    assert rws.type == "remote_worker_session"
    assert rws.is_host("host-1") is True
    assert rws.is_host("guest-1") is False
    assert rws.is_host(None) is False


def test_prompt_completion_shape():
    pr = PromptCompletion(prompt_id="p1", text="42", result_preview="42", asset_refs=["markdown-x"])
    dumped = pr.model_dump(mode="json")
    assert dumped["type"] == "prompt_completion"
    assert dumped["result_preview"] == "42"
    assert dumped["asset_refs"] == ["markdown-x"]
    assert pr.status == "complete"


def test_prompt_completion_attachment_is_not_a_runnable_prompt():
    """The inbound auto-run gate must ignore prompt_completion attachments."""
    from flow_sdk.app.actions.notification_action import _is_prompt_attachment
    from flow_sdk.cloud_client.hub_bridge import _has_prompt_attachment

    result_att = Attachment(attachment_type=AttachmentType.TYPE_ID, data="prompt_completion-abc")
    prompt_att = Attachment(attachment_type=AttachmentType.TYPE_ID, data="prompt-abc")

    assert _is_prompt_attachment(result_att) is False
    assert _is_prompt_attachment(prompt_att) is True
    assert _has_prompt_attachment([result_att]) is False
    assert _has_prompt_attachment([prompt_att]) is True


def test_prompt_limit_rides_the_snapshot_and_the_count_is_the_hosts():
    from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession as RWS

    # host row materialized without the guest's proposal: the limit is filled once
    host = RWS(conversation_id="c", host_user_id="h", status="pending")
    RWS.apply_snapshot(host, {"prompt_limit": 1, "prompts_used": 5}, local_is_host=True)
    assert host.prompt_limit == 1 and host.prompts_used == 0  # a guest never writes the count
    assert not host.limit_reached

    # guest adopts the count only from a fresher host snapshot
    guest = RWS(conversation_id="c", prompt_limit=1, last_activity_at="2026-11-04T10:00:00+00:00")
    RWS.apply_snapshot(guest, {"prompts_used": 1, "last_activity_at": "2026-11-04T09:00:00+00:00"}, local_is_host=False)
    assert guest.prompts_used == 0
    RWS.apply_snapshot(guest, {"prompts_used": 1, "last_activity_at": "2026-11-04T11:00:00+00:00"}, local_is_host=False)
    assert guest.prompts_used == 1 and guest.limit_reached

    # a live session has no limit, whatever it counts
    assert not RWS(conversation_id="c", prompts_used=40).limit_reached
