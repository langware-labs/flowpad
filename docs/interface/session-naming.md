# Worker session names

`AgenticProcess.name` is the canonical display name. The backend naming service
updates it and every linked process tab in one transaction, then publishes after
commit. The browser submits explicit renames or raw terminal evidence; it does
not decide provider provenance or save automatic labels.

## Priority and state

The shared reducer in `builtin/agentic_process/naming/state.py` has five phases:

- `unnamed`: no human prompt or usable provider title yet.
- `prompt_fallback`: the normalized first human prompt, capped at 80 characters.
- `harness`: a provider title with verified automatic provenance.
- `user_pinned`: an explicit user choice, including same-text renames.
- `protected_unknown`: an imported title whose provenance cannot be established.

User choices win over automatic titles; verified harness titles replace prompt
fallbacks. The first prompt remains stored as a backup. Unknown-origin imports
and uncertain legacy names are protected. Newer explicit user edits can replace
protected names; automatic observations cannot. Native source revisions reject
replays and stale session observations. A Flowpad rename consumes the current
native source cursors before applying the user edit, preventing an already-existing
native manual title from replaying over that edit.

Legacy migration retains conflicting candidates for diagnosis. Ordinary stale
entity saves cannot overwrite maintained naming fields. A missing process is
never recreated by a naming observation. Loader-supplied tab labels are not
worker naming evidence.

## Provider hooks

Provider adapters supply read-only title observations and filesystem watch paths.
The shared runtime owns subscription, session binding, reconciliation and shutdown.
Backend subscriptions operate independently of mounted terminals, and startup
restores subscriptions for active processes. Native identity discovery uses the
existing bounded driver transcript descriptor when a PTY has not yet reported
its session id. The shared `report_event/first_prompt` handler supplies an
immediate provisional title from the existing terminal input event.
`worker_history_changed` is published after a title or native identity changes;
history hooks refetch on that semantic signal rather than on status traffic. Missing metadata retains the last
usable name. Nothing writes titles back into native provider storage.

| Worker | Native title source | Provenance |
| --- | --- | --- |
| Claude | Full/incremental transcript title metadata | `custom-title` is user; automatic title metadata is harness |
| Codex | `session_index.jsonl`, latest native `updated_at` | Unknown: auto and manual use the same shape |
| Copilot | `workspace.yaml` name and `user_named` | Native explicit/automatic marker |
| OpenCode | Read-only SQLite `session.title` | Unknown: auto and manual use the same column |

Claude terminal title evidence prefers durable metadata. Unclassified usable OSC
text is protected. Other providers do not infer user intent from OSC decoration.

Codex and OpenCode **cannot safely track subsequent native manual renames after
an unknown title has been protected** without additional verified user-input
provenance. Their metadata alone does not provide that evidence; a name change
is not proof of user intent. Explicit Flowpad renames remain supported.

Provider launch environments use the same configured native homes as readers,
including isolated validation homes. A conflicting launch override is rejected.

## Validation

Focused tests cover reducer precedence, same-text pinning, native cursor replay,
legacy conflicts, stale saves, atomic tab projection and post-commit publication.
A real filesystem watcher test appends a Codex native title after the prompt and
verifies the tab updates without another transcript event or mounted browser.

Real CLI and browser validation must report each worker in PTY and headless mode
separately. Authentication failures, absent workers and unexecuted cells are
blocked or unverified, never successful tests. Native Codex/OpenCode provenance
limitations also remain explicit rather than being hidden behind heuristics.

Native reference sources: Codex's [session index implementation](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/session_index.rs)
defines the append-only naming file. Claude's [session management documentation](https://code.claude.com/docs/en/sessions)
documents explicit `/rename` and named resume. Local CLI experiments remain the
validation source for the installed versions' exact metadata and timing.
