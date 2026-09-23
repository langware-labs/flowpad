---
id: f0d3d1f4-a35d-4443-a6a1-e8ef67d77301
---
# Worker session names

`AgenticProcess.name` is the canonical display name. The backend naming service
updates it and every linked process tab in one transaction, then publishes after
commit. The browser submits explicit renames only; it never reports terminal
titles, decides provider provenance or saves automatic labels.

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

## When names move

Nothing watches the filesystem for names. A name moves on two kinds of edge:

- **Transcript event.** The transcript streamer delivers a session's new entries
  (`transcript_subscriber._route_to_ap` → `AgenticProcess.on_transcript_change`).
  The debounced flush calls `naming.runtime.apply_transcript_names`, which asks
  the provider adapter whether the batch can carry a title
  (`transcript_may_rename`) and only then reads the native store once. It runs
  before the flush's lifecycle gate, so a title written while a process is
  starting or after its worker exited still applies.
- **Lifecycle edge.** Open, resume, the first prompt
  (`report_event/first_prompt`), session adoption and idle stamping call
  `refresh_process_name` once: migration, native identity discovery,
  first-prompt fallback and one adapter read. No subscription is left behind.

A per-process file watcher used to do this. It bound processes with no transcript
on disk to the whole projects dir, so every transcript write refreshed all of
them and stalled unrelated requests (2026-09-16,
`tests/long_tests/test_transcript_naming_does_not_stall_requests.py`).

A reconcile that would rewrite nothing takes no write transaction: it is planned
on plain reads, and only a plan with writes is re-planned under the lock.

**Native identity.** Claude and Copilot are launched with a preassigned session
id. Codex and OpenCode mint theirs after launch, so their first transcript event
matches no process; the subscriber then resolves each running, id-less process of
that vendor through its driver's transcript discovery (workdir + launch time) and
adopts the id for the owner of that transcript. This is event-driven, never
polled.

`worker_history_changed` is published after a title or native identity changes;
history hooks refetch on that semantic signal rather than on status traffic.
Chat rows with a cached process also register a backend entity watch, so its live
name stays current in browsers without a mounted terminal. Missing metadata
retains the last usable name. Nothing writes titles back into native provider storage.

| Worker | Native title source | Provenance |
| --- | --- | --- |
| Claude | Full/incremental transcript title metadata | `custom-title` is user; automatic title metadata is harness |
| Codex | `session_index.jsonl`, latest native `updated_at` | Unknown: auto and manual use the same shape |
| Copilot | `workspace.yaml` name and `user_named` | Native explicit/automatic marker |
| OpenCode | Read-only SQLite `session.title` | Unknown: auto and manual use the same column |

| Worker | Transcript events | When a harness title applies |
| --- | --- | --- |
| Claude | Yes | The event whose entries carry `ai-title` / `custom-title` |
| Codex | Yes | The next transcript event after `session_index.jsonl` changes |
| Copilot | No | Lifecycle edges only |
| OpenCode | No | Lifecycle edges only |

Terminal (OSC) titles are not naming evidence. Names stored from the retired
`claude.terminal` source as `protected_unknown` are released to `harness`, so a
transcript title can replace them. A Claude `/clear` or fork gets a new session
id that no process owns, so its titles do not rename the original process.

Codex and OpenCode **cannot safely track subsequent native manual renames after
an unknown title has been protected** without additional verified user-input
provenance. Their metadata alone does not provide that evidence; a name change
is not proof of user intent. Explicit Flowpad renames remain supported.

Provider launch environments use the same configured native homes as readers,
including isolated validation homes. A conflicting launch override is rejected.

## Validation

Focused tests cover reducer precedence, same-text pinning, native cursor replay,
legacy conflicts, stale saves, atomic tab projection and post-commit publication.
Transcript-event tests deliver real transcript files through
`transcript_streamer_registry.notify_change`: a Claude `ai-title` renames the
process and tab, a Codex index title applies on the next event, and a
terminal-typed Codex session is adopted from its first event. The long-tier
test proves a writing session leaves unrelated request awaits unchanged.

Real CLI and browser validation must report each worker in PTY and headless mode
separately. Authentication failures, absent workers and unexecuted cells are
blocked or unverified, never successful tests. Native Codex/OpenCode provenance
limitations also remain explicit rather than being hidden behind heuristics.

Native reference sources: Codex's [session index implementation](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/session_index.rs)
defines the append-only naming file. Claude's [session management documentation](https://code.claude.com/docs/en/sessions)
documents explicit `/rename` and named resume. Local CLI experiments remain the
validation source for the installed versions' exact metadata and timing.
