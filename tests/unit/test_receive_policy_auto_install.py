"""receive_policy='auto' — row-only payload rides the ONE staged→install pipeline.

Row-only received entries (claude_session, flowpad_diagnosis) used to
materialize their entity rows in bespoke unpack branches, skipping the
MessageAttachment bookkeeping (and with it the install action's project
moment). Now unpack STAGES them like every payload entry and immediately
installs through ``handle_attachment_install`` — 'auto' means "no review
gate", not "skip the pipeline". This pins the contract:

- an MA row exists, installed at user scope with no project_id (scope
  inherits live through the parent-chain fallback);
- the entity row materializes from the staged header, with the type's
  ``receive_row_overrides`` applied (claude_session stamps received=True);
- uninstall reverts the MA to staged and destroys only the row.

# do not increase timeout without approval
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from flow_sdk.app.actions.message_attachment_action import handle_attachment_uninstall
from flow_sdk.builtin.claude_session import ClaudeSession
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
from flow_sdk.builtin.flowpad_diagnosis import FlowpadDiagnosis
from flow_sdk.builtin.message_attachment import MessageAttachment

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

async def _roundtrip(entity, type_name: str, fm_id: str) -> Path:
    fm = FlowMessage.model_validate(
        {"text": "share", "attachment": [{"attachment_type": "type_id", "data": f"{type_name}-{entity.id}"}]}
    )
    fm.id = fm_id
    zip_path = await pack_bundle(fm, dest_dir=Path(tempfile.mkdtemp()))
    await entity.delete()  # simulate a clean receiver
    await unpack_bundle(zip_path, local_user_id="receiver")
    return zip_path


@pytest.mark.asyncio
async def test_claude_session_stages_and_auto_installs() -> None:
    sess = ClaudeSession.model_validate({"name": "shared session", "slug": "shared-session"})
    await sess.save(None)
    fm_id = "aaaaaaaa-0000-4000-8000-0000000000fe"
    await _roundtrip(sess, "claude_session", fm_id)

    mas = await MessageAttachment.get_all({"flow_message_id": fm_id})
    ma = next((m for m in mas if m.asset_type == "claude_session"), None)
    assert ma is not None, "unpack must stage an MA row for the row-only entry"
    assert ma.installed and ma.scope == "user"
    assert not ma.project_id, "auto-install never stamps a project (parent-chain fallback owns scope)"

    restored = await ClaudeSession.get_one({"id": sess.id})
    assert restored is not None, "install must materialize the row from the staged header"
    assert restored.received is True, "receive_row_overrides must apply (received=True)"
    assert restored.remote is False
    assert restored.name == "shared session"


@pytest.mark.asyncio
async def test_diagnosis_auto_installs_and_uninstall_reverts_to_staged() -> None:
    diag = FlowpadDiagnosis.model_validate({"title": "Stuck button", "rca": "loose wire"})
    await diag.save(None)
    fm_id = "bbbbbbbb-0000-4000-8000-0000000000fe"
    await _roundtrip(diag, "flowpad_diagnosis", fm_id)

    mas = await MessageAttachment.get_all({"flow_message_id": fm_id})
    ma = next((m for m in mas if m.asset_type == "flowpad_diagnosis"), None)
    assert ma is not None and ma.installed
    assert await FlowpadDiagnosis.get_one({"id": diag.id}) is not None

    # Uninstall: row-only — no installed_root to sweep; row destroyed, MA staged.
    res = await handle_attachment_uninstall(ma.id)
    assert res.status == "SUCCESS", res.message
    assert await FlowpadDiagnosis.get_one({"id": diag.id}) is None
    reloaded = await MessageAttachment.get_one({"id": ma.id})
    assert reloaded is not None and not reloaded.installed
