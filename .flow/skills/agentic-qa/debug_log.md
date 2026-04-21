# Agentic QA Debug Log

## 2026-04-21 — tests/unit/test_flow_message_roundtrip.py::TestPackBundle::test_pack_creates_zip_with_message_json

### Failure
`pydantic_core.ValidationError: Invalid TypeId identifier: 'task-id-001'` (and
`'conv-id-001'`) raised from `TypeId._pydantic_validate` while constructing
`FlowMessage` in the fixture `_make_flow_message` at
`tests/unit/test_flow_message_roundtrip.py:31`.

### Root cause
Pre-existing drift between the test fixture and the production model.

- In commit `f02259a add attachments`, `FlowMessage.context` was retyped from
  a permissive `list` (comment: `[{"type": str, "id": str}]`) to
  `list[TypeId]` (see `flow_sdk/builtin/flow_message.py:38`).
- `TypeId._pydantic_validate` -> `TypeId.__init__` calls
  `is_valid_identifier(entity_id)` (`flow_sdk/fs_store/type_id.py:60,67,74`),
  which requires the id to be a UUID, a `NAMESPACE-<int>` key, a
  `prop.id` prop-id, or an `@named` identifier
  (`flow_sdk/fs_store/identifier.py:109`).
- The fixture still passes the old-style plaintext ids
  `"task-id-001"` / `"conv-id-001"`, which are none of the above, so
  validation now rejects them.
- The test itself was authored in commit `8273d07` alongside the original
  permissive `FlowMessage.context: list` and has never been updated since
  the retyping. `git log tests/unit/test_flow_message_roundtrip.py` shows
  only that initial commit.

### Related to current session's work? NO.
The session's changes were:
- `AgenticProcess.trigger_id` -> `target_typeid_str` rename
- New prompt / cancel-prompt actions on `AgenticProcess`
- New `ClaudeCLIStreamWorker` + `claude_event_to_flowdata` converter

Grep for `trigger_id|target_typeid_str|claude_event_to_flowdata|ClaudeCLIStreamWorker`
in `flow_message.py`, `type_id.py`, `identifier.py`, and the failing test file
returns zero matches. None of these modules depend on `AgenticProcess` or the
prompt-stream plumbing. The validation path is entirely local to
`FlowMessage -> TypeId -> is_valid_identifier`.

### Classification
(b) Pre-existing regression, introduced on the `add attachments` commit
(`f02259a`) on a prior branch/session, not by this session's work. It only
surfaces now because the e2e-qa cycle is running the full unit suite.

### Recommended fix (one-liner)
Update `_make_flow_message` in `tests/unit/test_flow_message_roundtrip.py` to
use valid identifiers in `context`, e.g. UUIDs
(`{"type": "task", "id": "<uuid4>"}`) or `NAMESPACE-<int>` keys
(`{"type": "task", "id": "TASK-1"}`) — no production-code change required.
