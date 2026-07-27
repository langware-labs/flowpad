---
id: 10f4e57c-07b4-5272-9750-0fd51154d0c1
---

# Interface Reference — the agentic-process stack

Complete interface reference for the objects that run agents and terminals: what
exists on each side (Python backend / TypeScript SDK), every backend action and
the Python method it calls, and the canonical flows as the tests drive them.
Every reference page uses the same skeleton: **Python object & API → Backend
actions → Frontend TS interface → Flows**.

These pages are the *API surface*; the narrative story (why, lifecycle
walkthroughs, recovery sequences) lives in `docs/agent-management/` and is
cross-referenced, never duplicated.

## Files

| File | Covers |
| --- | --- |
| [agentic-process.md](./agentic-process.md) | `AgenticProcess` — fields, all 38 backend actions → Python mapping, TS class, spawn payload contract (`AgenticContext`) |
| [shell.md](./shell.md) | `Shell` entity (4 actions) + TS `Shell`/`PtyConnection`; shell_mode vs direct spawn |
| [pty-layer.md](./pty-layer.md) | Internal PTY layer: `PtyRegistry`/`PtyState`, `PtyStreamFile`, provider PTY surface, WS lifecycle + `GET /shell/{id}/pty-stream` replay route |
| [compute-node.md](./compute-node.md) | `ComputeNode` — 44 actions grouped by mixin; `createProcess`/`upsertSessionProcess` factories; TS class |
| [cli-drivers.md](./cli-drivers.md) | `WorkerDriver` 14-method contract, `WorkerCLIOptions`, per-CLI matrix (claude/codex/copilot) |
| [status-model.md](./status-model.md) | Paired status enums/predicates backend↔TS, parity table, serialization path |
| [flows.md](./flows.md) | Test-derived canonical flows + critique (non-slick flows, coverage gaps) |

## Layering

```
┌───────────────────────────────────────────────────────────┐
│  AgenticProcess — agent semantics                         │  Layer 3
│  session_id + transcript, prompting, restart, drivers     │
├───────────────────────────────────────────────────────────┤
│  Shell — managed PTY entity                               │  Layer 2
│  DB row per terminal tab, worker tracking, env            │
├───────────────────────────────────────────────────────────┤
│  Pty — raw pseudo-terminal                                │  Layer 1
│  PtyRegistry/PtyState, .pty stream file, WS transport     │
└───────────────────────────────────────────────────────────┘
```

Each layer is independently usable and has no knowledge of the layer above it.
(Refreshed from the historical root `AgentApi.md` framing.)

## Rules & invariants

These are the normative contracts. Code that violates them is a bug; the known
violations are flagged inline as debt.

1. **Transport vs visibility are two independent fields.**
   `pty_mode` (default `True`) is the *transport*: `True` = long-lived
   interactive worker in a Shell PTY; `False` = headless one-subprocess-per-turn
   JSON stream (`claude -p --output-format stream-json`, `codex exec --json`).
   `visible` is *tab visibility only* (mutable alone via `set-visible`).
   **All routing keys on `pty_mode`, never `visible`.**
   Only enforced coupling: `visible=true ⟹ pty_mode=true` (`_perform_open`).
   *Known debt:* `get_worker_mode`, `classify_execution_mode`, and
   `pty_recovery.py` still derive from `visible` — display projections and a
   confirmed recovery bug respectively; see [status-model.md](./status-model.md).

2. **One logical session across transports.** A process has one `session_id`
   and one vendor CLI transcript regardless of transport; `switch-mode`
   preserves both. `session_id` is a *worker* id, not an entity id — never feed
   it to TypeId construction (codex mints v7 rollout ids).

3. **Mid-turn guard.** A prompt turn in flight ⇒ 409 on `prompt` and on
   `switch-mode`→CLI. *Known asymmetry (debt):* `switch-mode`→interactive and
   `restart` have no backend guard — the UI gates them.

4. **`restart_required` is a snapshot-hash contract.** `save()` while RUNNING
   compares the worker-config snapshot (MD5 of generic + finalized CLI options,
   excluding transient `resume`/`fork_session_id`) against `last_started_hash`
   and sets the flag; only a successful `start_pty()` clears it. *Known debt:*
   it is never cleared on config revert (phantom glow).

5. **Resume is driver-gated.** `--resume` is passed only when
   `driver.has_resumable_session()` — claude checks its session store (and is
   the only driver supporting fork + plan mode, with `pins_resume_cwd`);
   codex mints its own rollout id (ignores preassigned ids); copilot
   file-probes. Non-resumable ⇒ fresh relaunch (context loss is silent).

6. **Exit vs close.** `AgenticProcess.exit` kills the worker+PTY but
   **preserves** the linked `Shell` (tab resumable). `Shell.close` **deletes**
   the shell record and entity. Don't conflate them.

7. **One respawn owner.** PTY (re)creation belongs to
   `_perform_open`/`start_pty` (serialized by `_OPEN_LOCKS`, knows
   `spawn_args`). *Known debt:* the provider input/resize retry path and
   bare-shell recovery both respawn outside this owner.

8. **PTY replay is disk-framed.** Scrollback recovery reads the framed `.pty`
   stream file over `GET /shell/{id}/pty-stream`; WS attach does **no** byte
   replay (repaint jiggle only); `seq` is monotonic across respawns (seeded
   from `max_seq()`). There is no in-memory replay buffer.

9. **URL-first navigation.** Click handlers only navigate; the route loader is
   the single writer of context (see repo `CLAUDE.md`). The loader attaches a
   PTY only when `pty_mode !== false`.

10. **Entity ids are UUID v4/v5, minted via `mint_uuid`** (see `CLAUDE.md`).
    Foreign ids (worker session ids, frontmatter) must pass
    `is_valid_entity_id` before adoption.

## Related docs

- Narrative: [docs/agent-management/agentic-process.md](../agent-management/agentic-process.md)
  (two-axis model), [mode-switching.md](../agent-management/mode-switching.md),
  [claude-session-manager.md](../agent-management/claude-session-manager.md),
  [pty-websocket.md](../agent-management/pty-websocket.md)
- Recovery: [docs/pty-sync.md](../pty-sync.md) Part 3.5
- Rendering: [docs/pty-terminal-spec.md](../pty-terminal-spec.md) §14
- Shell vs agentic PTY: [docs/shell-claude-session-api.md](../shell-claude-session-api.md)
- Historical: root `AgentApi.md` (three-layer design spec, pre two-axis model)
