---
id: 69b3f08c-4316-5b87-a6bb-f49c1c3d1c31
---

# shellMode vs Direct / Agentic PTY

Consolidated reference for how a **plain shell terminal** differs from an
**agentic process running over a PTY**. Both ride the one PTY stack (transport,
replay, attach/input/resize) documented in
[`pty-terminal-spec.md`](./pty-terminal-spec.md) and
[`agent-management/pty-websocket.md`](./agent-management/pty-websocket.md); tab
placement/lifecycle is [`tab-management.md`](./tab-management.md). This doc only
covers what is *different* between the two shapes — creation paths, entity/record
model, `shell_mode`, title/rename, and recovery — and points at those docs for
the shared machinery rather than restating it.

> **Note:** an earlier version of this file documented a client-side domain API
> under `ts_sdk/src/domain/` (`Shell` / `ClaudeSession` / `ClaudeSessionRecord`
> interfaces). **That module does not exist in the tree.** The real client
> surfaces are the `Shell` entity wrapper (`ts_sdk/src/entities/shell.ts`, one
> eager `PtyConnection`) and the `AgenticProcess` entity
> (`ts_sdk/src/process/agentic-process.ts`). This rewrite reflects the as-built
> code.

---

## 1. The core distinction

Both a plain terminal and an agent-in-a-terminal are the **same OS PTY + the
same `Shell` entity as transport**. The difference is *what runs as the PTY
process* and *whether an `AgenticProcess` sits on top*:

| | Plain shell tab | Agentic process tab |
|---|---|---|
| Tab identity | `shell-<id>` (the `Shell`) | `agentic_process-<id>` (the `AgenticProcess`) |
| Entities | `Shell` only | `AgenticProcess` (identity) **+** `Shell` (transport, `AgenticProcess.shell_id`) |
| PTY process | `$SHELL` / `/bin/zsh` (`spawn_args=None`) | the worker CLI itself, e.g. `claude --session-id …` (`spawn_args=[…]`), unless `shell_mode=True` |
| `Shell.worker_pid` | `None` (no tracked worker) | set — the worker process |
| Worker session / transcript | none | `AgenticProcess.session_id` + Claude/Codex `.jsonl` transcript |
| Headless (no PTY) mode | n/a | yes — `visible=False` prompt turns run CLI print/exec, no PTY (§6) |
| Creation entry point | `navigation.openNewShell` | `navigation.openNewClaudeProcess` |
| Recovery after restart | `_recover_bare_shells` (respawn `$SHELL`) | `run_pty_recovery` (`claude --resume <session_id>`) |

Everything below the PTY handle — WebSocket transport, framed stream replay,
attach/detach FSM, resize, TTL cleanup — is **identical** for both. See the two
PTY docs.

---

## 2. Plain shell tab — creation & model

Frontend: `NavigationActions.openNewShell` (`ui/src/navigation/NavigationActions.ts:495`):

1. `Shell.create(cn, { name, workdir })` — `name` is the next free `"Tab N"`
   (`nextTerminalName`, `ui/src/components/terminal/rename-rules.ts:38`).
2. Stamps `project_id` (caller-pinned → active dock project → backend default
   `@local`), `newShell.save(cn.typeId)`.
3. `openShell(shellId)` → navigates to `shell.dockPointer` (`shell-<id>`).

On mount the terminal view drives `Shell` `open`
(`flow_sdk/builtin/shell.py:816` `_http_open` → `start_pty`). With **no
`spawn_args`**, the provider spawns the login shell (`$SHELL`, else `/bin/zsh` on
macOS, `/bin/bash`/`/bin/sh` on Linux, `pwsh`→`powershell`→`cmd` on Windows —
`agent-management/pty-websocket.md` §3). There is no `AgenticProcess`, no
`worker_pid`, no `session_id`, no transcript. Persistence is the `ShellRecord` +
its `PtyStreamFile` only (`pty-terminal-spec.md` §10–12).

---

## 3. Agentic process tab — creation & model

Frontend: `NavigationActions.openNewClaudeProcess` (`NavigationActions.ts:465`)
→ `computeNode.createProcess({ workdir, projectId, workerType }, { visible:true })`
mints an `AgenticProcess`, then `openShellProcess(processId)` navigates to
`process.terminalDockPointer` (`agentic_process-<id>`). The loader calls
`process.start({ visible:true })`, which creates or reuses a `Shell` as
transport and spawns the worker.

Backend `AgenticProcess.open/start`
(`flow_sdk/builtin/agentic_process/agentic_process.py:1103`) branches on
`shell_mode` (`agentic_process.py:403`, `APIField(default=False)`):

### `shell_mode=False` — direct PTY spawn (default)

The **worker CLI is the PTY process** — no intermediary shell:

```
cmd.to_spawn_args(instruction) → (argv, env)          # e.g. ["claude","--session-id",…]
worker_path_env / run_discovery                        # prepend the CLI bin dir to PATH
shell.start_pty(spawn_args=argv, extra_env=env)        # provider spawns argv directly
shell.set_worker_pid_direct(cmd)                       # worker_pid = the PTY pid (no polling)
```

`set_worker_pid_direct` (`shell.py:671`) records `worker_pid = pty_pid` directly
because Claude *is* the PTY — no child-process hunting.

### `shell_mode=True` — legacy zsh intermediary

Kept for compatibility. Spawns a plain shell, then injects the command and hunts
for the worker child pid:

```
shell.start_pty()                                      # bare $SHELL PTY
shell.launch(cmd, instruction)                         # shell.py:624
  → shell.write(cmd.to_shell_string(instruction))      # types the command in
  → _poll_for_worker_pid(shell_pid, "claude", 1.0s)    # find the child pid
```

`worker_alive()` (`shell.py:696`) validates `worker_pid` still exists and its
cmdline matches `worker_name` (+ expected `--session-id`), used by both paths to
avoid double-launching and by recovery.

The direct path is preferred: no prompt-ready race, no injected-command grace
period, exact pid, and a clean `on_exit` mapping worker death → process status.

---

## 4. Title & rename behavior

OSC window-title handling is **entirely frontend** — there is no backend OSC
parser; `Shell.auto_rename` (`shell.py:117`) is only the gate deciding whether
xterm titles may overwrite `Shell.name`. `TerminalPanel`
(`ui/src/components/terminal/TabbedTerminal.tsx`) watches the xterm OSC title and,
when `auto_rename` is set and the target permits it:

- **`cleanTitle(raw)`** (`rename-rules.ts:11`, added
  commit `e3710f9c`) strips spinner frames (Braille/box glyphs), emoji/icons,
  rotation arrows, ANSI CSI escapes, and C0/C1 control bytes — so animation ticks
  that reduce to the same text never fire a save. Script-agnostic: removes
  symbols, never letters, so RTL/CJK titles survive.
- **`allowRename(clean)`** requires a real letter (`\p{L}`), rejects a bare
  TypeId, and rejects any `"Claude Code"` title (the CLI's default).
- On pass: `source.name = clean; source.save()` **and** `Tab.setNameById(clean)`
  (mirror to the durable Tab chip via `set_name`, **not** `rename` — `rename`
  would pin `auto_rename=false`; see `tab-management.md` Part 0 on
  `set_name` vs `rename`).

Which targets auto-title — `shouldAutoSaveTitleForTarget`
(`rename-rules.ts:61`): a **plain shell always** auto-titles; an **agentic
process** auto-titles **unless it is Codex/Copilot** (they emit unstable
titles). A user rename pins `auto_rename=false` and stops the mirror.

---

## 5. Tab handling

Both kinds are first-class `Tab` entities and share one strip
(`UnifiedTabStrip`), one store (`all-tabs-store`), and one body (`TabbedTerminal`)
— full model in [`tab-management.md`](./tab-management.md) Part 0. The only
kind-specific differences:

- **Chip glyph**: terminal tabs draw from `Tab.icon_key` + `PROVIDER_META`
  (claude/codex/copilot/terminal); content tabs from `iconForType` (backend
  TypeInfo). `tab-row-item.tsx` builds both generically.
- **Close semantics** (capability matrix, Part 3 §3): closing a shell/AP chip is
  **destroy-entity** (`tabs/close` → `tabbed=false` **and** PTY/worker teardown);
  `AgenticProcess.close` calls `hide_tabs_for_target` and the AP row persists as
  `stopped` (so entity-delete cleanup never fires for it), whereas a bare
  `Shell.close` deletes the record + entity.
- **Body attach**: `TabbedTerminal` warm-mounts one `TerminalPanel` per terminal
  `Tab`; each panel hydrates its own live entity (`Shell` for a bare tab, the
  `AgenticProcess` → its `shell_id` for a process tab) and attaches its PTY on
  mount (URL-first; no list-wide join).

---

## 6. Interactive vs headless (agentic only)

A plain shell is always interactive (it only exists as a PTY). An
`AgenticProcess` has two execution modes keyed on `visible`
(`agentic_process.py`, `status_predicates.py`):

- `visible=True` → interactive PTY path (§3) — a `Shell` + live PTY + replay.
- `visible=False` → `driver.headless_prompt(...)` — CLI print/exec, structured
  transcript capture, **no `Shell`, no PTY, no `pty_output_msg`**.

The bridge between modes is the worker `session_id` / transcript identity, not
the PTY: a process can preserve `session_id` across headless and interactive
opens and, when it becomes visible, resume/fork the existing transcript. See
`agent-management/pty-websocket.md` §10.

---

## 7. Recovery after a backend restart

In-memory PTY state is lost on restart; `flow_sdk/server/pty_recovery.py`
respawns by liveness, and the two shapes take **different** recovery paths:

- **Agentic**: `run_pty_recovery` (`pty_recovery.py:179`) respawns dead workers
  with `claude --resume <session_id>`; liveness = `has_attachable_pty() and
  worker_alive()`.
- **Bare shell**: `_recover_bare_shells` (`pty_recovery.py:258`) respawns
  recently-active plain terminals whose id is **not** owned by any AP; liveness =
  `has_attachable_pty()` alone (a bare shell has no worker to check).

Clients then re-`attach` to the rebuilt PTY via the normal flow.

---

## 8. Discrepancies & robustness concerns (for arch review)

- **No promotion of an in-shell agent.** If a user types `claude` inside a
  *plain* shell tab, nothing detects it or promotes the `Shell` to an
  `AgenticProcess` — there is no backend cmdline/OSC sniffing that mints an AP.
  The agent runs, but with none of the agentic machinery (`session_id`,
  transcript indexing, worker status, resume, headless bridge, `claude --resume`
  recovery). The two creation paths are the only way to get an agentic tab. This
  is a deliberate simplification but a real capability gap.
- **Two launch styles for one outcome** (`shell_mode` True/False). The legacy
  zsh-intermediary path (`shell.launch` + `_poll_for_worker_pid`) is a parallel,
  race-prone code path kept only for compatibility. Candidate for removal once no
  callers set `shell_mode=True`.
- **OSC title trust is client-only.** `auto_rename` gates on the backend but the
  *value* is whatever the frontend derives from xterm; `cleanTitle`/`allowRename`
  are the only sanitizers. A headless or non-browser client never contributes a
  title, so the durable name depends on a browser having viewed the tab.
- **Recovery liveness asymmetry.** Agentic recovery needs both an attachable PTY
  and a live worker; bare-shell recovery needs only the PTY. A worker that
  survived but whose PTY died, or vice versa, is handled by AP recovery, but the
  ownership split (`agentic_shell_ids` set) means a shell mislabeled between the
  two sets could be recovered by the wrong reaper.
