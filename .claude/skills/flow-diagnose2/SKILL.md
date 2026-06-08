Produce a Flowpad diagnosis for the user's issue and surface it for support.

**Act immediately. Your FIRST action is to run the consolidated `uv run` script
below — do not write a preamble, do not "check Flowpad state first", do not call
any other tool before it.** Announcing a plan and ending your turn is a failure:
nothing is recorded and the run is wasted. Run the script, see its output, then
report. Fill the four `FlowpadDiagnosisMetadata` fields from whatever you can infer
about the issue (a plausible diagnosis is fine — recording it is the goal).

Use the **flowpad-assistance** skill (records action) only as background for *how*
records are created. The work is done by the **single consolidated script below** —
it performs all five steps in one `uv run`, which is required: the calling agentic
process is streamed with a hard time budget, and spreading these across many
exploratory `uv run` cycles overruns it.

The five things this accomplishes:

1. Create a `FlowpadDiagnosisMetadata` record (records.md "Creating a record from
   a metadata object", Step 1 + Step 2) — fill `title / symptoms / rca / fix` from
   your analysis of the user's issue.
2. Cross-link the diagnosis to THIS agentic process (records.md Step 3) so the
   process ends up with the diagnosis in its private context.
3. Print the saved diagnosis details + id.
4. Create a `flow_message` with the diagnosis attached (a `TYPE_ID` attachment),
   appended to a hidden support conversation.
5. Create a `feed_entry` of kind `message_suggest` pointing at that message, so the
   user can review the diagnosis and send it to support in one click.

`flow_message` / `feed_entry` are plain `Entity` types (no metadata model), so they
are constructed and `.save()`d directly — the script below already does this the
canonical way (mirrors `flow_sdk/diagnostics/report.py`). Do not go re-discover
their shape; just fill in your analysis and run it.

## Do all five in ONE script

Replace only the four `FlowpadDiagnosisMetadata` field values with your analysis.
Everything else is fixed — run it as-is.

```bash
uv run python - <<'PY'
import asyncio
from datetime import datetime
from flow_sdk._compat import UTC
from flow_sdk.schema.type_info import register_all
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.fs_record import FSRecord
register_all()
import flow_sdk.models.entities  # noqa: F401 — registers entity classes (get_entity_cls / cross-link)

async def main():
    from flow_sdk.db.database import init_db
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.cli.commands._common import resolve_process_id
    from flow_sdk.core.entity.cross_link import cross_link_entities
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.feed_entry import FeedEntry, FeedKind, FeedStatus, MessageSuggest
    from flow_sdk.builtin.flow_message import FlowMessage, Attachment, AttachmentType
    from flow_sdk.fs_store.operations.conversation import (
        append_message_pointer, default_jsonl_path, from_jsonl, project_pointers_to_entity)
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.server.routes.bootstrap import get_or_create_local_project, get_or_create_local_user
    await init_db()

    # 1) Diagnosis record — SWAP these four values for your analysis.
    Model = SchemaRegistry.get("flowpad_diagnosis").meta_model
    meta = Model(
        name="Backend stuck on Starting",
        title="Backend stuck on Starting",
        symptoms="App shows 'Starting…' forever; console: failed to respond on :9007.",
        rca="Stale server.lock blocked the singleton bind.",
        fix="Clear the stale server.lock when the recorded PID is dead.",
    )
    rec = FSRecord("flowpad_diagnosis", id=None, **meta.model_dump(exclude_none=True))
    rec.save(); await rec.sync_to_db()
    print(f"OK created+verified flowpad_diagnosis-{rec.id}")

    # 2) Cross-link diagnosis <-> this process.
    proc = await AgenticProcess.get_by_id(resolve_process_id(None))
    diag = await SchemaRegistry.get_entity_cls("flowpad_diagnosis").get_by_id(rec.id)
    await cross_link_entities(proc, diag)
    print(f"OK cross-linked {proc.typeid} <-> {diag.typeid}")

    # 3) Human-readable summary.
    print(f"Diagnosis: title={meta.title!r} symptoms={meta.symptoms!r} rca={meta.rca!r} fix={meta.fix!r}")

    # 4) Hidden support conversation + flow_message with the diagnosis attached.
    user = await get_or_create_local_user()
    project = await get_or_create_local_project(desktop_user=user)
    owner = user.typeid
    title = f"Flowpad diagnostics — {datetime.now(UTC):%Y-%m-%d %H:%M}"
    conv = Conversation.model_validate({"project_id": project.id, "participants": [], "title": title, "name": title})
    conv.id = Conversation.allocate_id(conv.model_dump())
    conv = await conv.save(owner); await project.attach_child(conv)
    crec = from_jsonl(default_jsonl_path(conv.id), project.id, conv.id, parent_type=RecordType.PROJECT); crec.save()

    msg = FlowMessage(
        text=f"{meta.title}\n\nSymptoms: {meta.symptoms}\nRCA: {meta.rca}\nFix: {meta.fix}",
        conversation_id=conv.id, sender_id=user.id, sender_name="Flowpad Diagnostics",
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"flowpad_diagnosis-{rec.id}")],
    )
    msg = await msg.save(owner)
    append_message_pointer(crec, msg.id, datetime.now(UTC).isoformat())
    await project_pointers_to_entity(crec, notify=False)
    conv = await Conversation.get_one({"id": conv.id}); conv.dismissed_at = datetime.now(UTC); await conv.save(owner)
    print(f"OK flow_message-{msg.id} (attached flowpad_diagnosis-{rec.id})")

    # 5) FeedEntry (message_suggest) — the Home-landing Feed card.
    suggest = MessageSuggest(
        text="An error came up while using Flowpad — here's what the diagnostic found:",
        conversation_id=conv.id, flow_message_id=msg.id, message_text=meta.title)
    feed = FeedEntry(kind=FeedKind.MESSAGE_SUGGEST.value, feed_status=FeedStatus.NEW.value, feed_data=suggest.model_dump())
    feed = await feed.save(owner)
    print(f"OK feed_entry-{feed.id}")
    print("ALL FIVE STEPS DONE")

asyncio.run(main())
PY
```

## Done means

The script printed `OK cross-linked …`, `OK flow_message-…`, `OK feed_entry-…`,
and `ALL FIVE STEPS DONE`. You are not done until those lines are on screen. Then
report the diagnosis (`title / symptoms / rca / fix`) and its TypeId in plain text,
and stop — do not start anything else.
