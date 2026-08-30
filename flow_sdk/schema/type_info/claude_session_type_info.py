"""Type metadata for CLAUDE_SESSION."""

import uuid

from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.claude_sessions import (
    claude_session_id_from_file,
    claude_session_identity_key,
    extract_claude_session,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

CLAUDE_SESSION = TypeMetadata(
    type=EntityType.CLAUDE_SESSION,
    indexed_by_default=True,
    # Same defect AGENTIC_PROCESS documents: the broadcast gate in
    # ``resource_tracker._sync_handle_entity_op`` drops every data_op for a type
    # that isn't api-visible, and its only exemption covers update/delete — a
    # CREATE never qualifies. So installing a received transcript announced
    # itself into a void: the conversation's chip kept the 404 it cached before
    # the install, which left it dashed AND left it without the ``asset_ref``
    # it needs to open the file, so it fell back to a session-id lookup that
    # only resolves on the machine that RAN the session (the receiver gets
    # "NOT_FOUND: ~/.claude/projects/ not found").
    #
    # Costs nothing at rest: the indexer persists session rows with
    # ``notify=False``, so a live transcript's appends still broadcast nothing.
    # Every sibling of this type — remote_worker_session, agent_trace,
    # workflow_run, usage_report — is already visible; these three were the only
    # user-facing types left out, inherited from the initial 0.2.0 import.
    api_visible=True,
    # The vendor logo, resolved through the custom-icon seam in
    # ``ts_sdk``/``lucide-by-name``. Declared here so EVERY surface picks it up
    # via ``iconForType`` — including a received transcript's attachment chip,
    # which had no per-type glyph and fell back to the generic document icon.
    icon="ClaudeCode",
    from_disk_fn=extract_claude_session,
    identity_carrier=derived_identity(claude_session_id_from_file),
    identity_key_fn=claude_session_identity_key,
    id_namespace=uuid.NAMESPACE_DNS,
    # A session IS its transcript file, so it is an ordinary file-backed asset:
    # the ONE generic packer/installer handles it, and the bytes never travel
    # under a separate name. REPO, not HARNESS: Claude Code's own session store
    # is ``~/.claude/projects/<proj>/<id>.jsonl`` (globbed by ``claude_sessions_fn``)
    # — it has never read a ``.claude/transcripts``, so an INSTALLED transcript is
    # a flowpad artifact and belongs in the repo hierarchy. Which CLI produced it
    # is carried by the TYPE, so no ``harness`` declaration is needed.
    asset_class="repo",
    family="claude_session",
    main_layout="file",
    main_ext=".jsonl",
    # No ``receive_policy``: a shared transcript stages and waits for the normal
    # review → pick-a-project → install gate like every other attachment.
    # ``received=True`` marks it never ran here (so it is not resumable);
    # ``remote=False`` because it has no hub twin of its own. Applied on install
    # by ``_apply_receive_row_overrides`` regardless of which branch ran.
    receive_row_overrides={"remote": False, "received": True},
)
