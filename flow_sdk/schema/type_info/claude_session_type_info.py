"""Type metadata for CLAUDE_SESSION."""

import uuid

from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.claude_sessions import (
    claude_session_id_from_file,
    claude_session_stable_key,
    extract_claude_session,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

CLAUDE_SESSION = TypeMetadata(
    type=EntityType.CLAUDE_SESSION,
    indexed_by_default=True,
    # The vendor logo, resolved through the custom-icon seam in
    # ``ts_sdk``/``lucide-by-name``. Declared here so EVERY surface picks it up
    # via ``iconForType`` — including a received transcript's attachment chip,
    # which had no per-type glyph and fell back to the generic document icon.
    icon="ClaudeCode",
    from_disk_fn=extract_claude_session,
    identity_backend=derived_identity(claude_session_id_from_file),
    id_stable_key_fn=claude_session_stable_key,
    id_namespace=uuid.NAMESPACE_DNS,
    # A session IS its transcript file, so it is an ordinary file-backed asset:
    # the ONE generic packer/installer handles it, and the bytes never travel
    # under a separate name. Harness-scoped like ``agent_trace`` /
    # ``usage_report`` — the same genre (a record produced BY one worker), and
    # the class that allows a global install alongside a project one.
    asset_class="harness",
    harness="claude",
    family="transcripts",
    main_layout="file",
    main_ext=".jsonl",
    # No ``receive_policy``: a shared transcript stages and waits for the normal
    # review → pick-a-project → install gate like every other attachment.
    # ``received=True`` marks it never ran here (so it is not resumable);
    # ``remote=False`` because it has no hub twin of its own. Applied on install
    # by ``_apply_receive_row_overrides`` regardless of which branch ran.
    receive_row_overrides={"remote": False, "received": True},
)
