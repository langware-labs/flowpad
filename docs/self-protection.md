# FlowPad AI Self-Protection — Enforcement Design (FLOWPAD-2112)

> Status: design + verification. Not implemented. This document is the deliverable
> that an implementation PR is built from. Verified claims are marked ✅ with where
> they were proven; unverified ones are marked ⬜.

## 1. Incident and problem

In Vibe Mode, on a remote Windows machine, the in-app AI ran commands that killed
FlowPad itself. The exact command was not captured. The shipped `flow-diagnose`
skill prescribes, for "Port 9007 occupied" (A1), `taskkill /PID <pid> /F` on
Windows (`.claude/skills/flow-diagnose/SKILL.md:359-363`,
`references/catalog.md:18`) — and the detection step (`lsof -ti tcp:$PORT` /
`netstat`) returns the backend's own PID, because the backend is what holds the
port. So a literal follow of the skill kills the backend.

An AI worker holds the user's full permissions and runs as the same OS user as the
backend and the Electron shell. The OS therefore permits it to kill them: a process
killing another process of the same user is allowed. Protection must be enforced in
code / by construction, not by telling the AI what not to do.

## 2. The invariant

**A live FlowPad activity is never killed or disrupted by another FlowPad activity**,
regardless of which subsystem initiated it (AI worker, a skill, a diagnosis request,
lifecycle code, Electron, or an innocent user request).

Two sub-rules:
- **May clean up** — a dead process, a port held by a dead process, the user's own
  stuck `python`, the worker's own dev server, an unrelated/foreign process.
- **Must not suicide** — a live backend / monitor / Electron / lifecycle supervisor.

The hard part is the distinction, not the blocking. Identity is **PID + create_time**,
never image name (the backend shares the `python` image with a user's script, so a
name-based "kill python" must spare it by PID, not by name).

## 3. Actors and why the worker is special

Most kill paths are our own trusted code and will consult the guard voluntarily. The
**AI worker** (and the agent an untrusted remote **diagnosis request** spawns) is the
one actor that will not — it can issue a raw `taskkill`/`kill`. So the worker alone is
wrapped in an OS boundary; everyone else is covered by an in-code guard.

## 4. Protection layers

Each: what it prevents · where enforced · can a same-user worker bypass it · residual ·
test + status.

### L0 — Protected-set (single source of truth)
- **Prevents:** nothing by itself; answers "is this a live protected FlowPad process".
- **Enforced:** new `flow_sdk/core/self_protection/{spec,registry,guard}.py`.
  `ProtectedProcessSpec(DataSpec)` {role, pid, create_time, instance} written per
  process to `<instance_dir>/runtime/<role>-<pid>.json`; `partition_kill(targets,
  caller)` → (allowed, refused).
- **Bypass:** discovery only; it is not a boundary, so forging it does not move the OS
  boundary. Forge/delete closed by L1 filesystem protection (runtime dir + ancestors).
- **Test:** reference impl verified in the harness (`partition_kill` spares backend,
  kills user python). ✅ harness.

### L1 — OS containment of the worker (the boundary for the non-compliant actor)
- **Prevents:** direct kill, `WM_CLOSE`, and writes to system/config files, by the worker.
- **Enforced:** one `contain_agent_argv()` at every spawn —
  `cli_drivers/cli_worker_base_driver.py` (`apply_worker_env`), each
  `cli_drivers/*/stream_worker.py`, `cli_drivers/jsonl_tee_worker.py`,
  `compute/providers/desktop/provider.py` (`PtyProcess.spawn`, `run_command`).
  New `self_protection/os_{windows,macos,linux}.py`.
  - **Windows:** worker at **Low IL** — cannot open a Medium process for TERMINATE,
    UIPI blocks `WM_CLOSE`, `NO_WRITE_UP` blocks writes to medium dirs (`~/.flow`,
    `site-packages`, `~/.claude`). Every worker write target (TEMP/TMP, caches,
    transcript dir) must be relocated to Low-labeled dirs.
  - **macOS:** `(deny signal)(allow signal (target same-sandbox))` + a **write-allowlist**
    (`deny file-write*`, allow only the workspace). Deny-list is NOT enough — it is
    bypassed by renaming a writable ancestor; the allowlist closes that. SBPL is
    last-match-wins, so no allow may re-include a protected ancestor.
- **Bypass:** no, given a genuine low/sandboxed token. ❗ **real-browser does not run at
  Low IL** (Chrome's browser process dies) — see L2 carve-out. Elevated worker (SeDebug)
  would bypass — the worker must be non-elevated.
- **Test:** ✅ UTM VM (kill blocked, Low-IL filesystem blocked, node/dev-server/loopback
  work) · ✅ macOS sandbox (allowlist closes ancestor-rename) · ⬜ Linux (no VM).

### L2 — Windows process-object DACL + `OWNER_RIGHTS`
- **Prevents:** the owner re-granting itself `WRITE_DAC`→`TERMINATE` on the backend/Electron.
- **Enforced:** self-harden at startup — backend near the top of
  `server/app.py::_on_server_startup`, Electron in `electron/main.js`.
- **Bypass:** DACL alone — **yes** (owner implicitly holds WRITE_DAC). DACL + an explicit
  `OWNER_RIGHTS` (S-1-3-4) ACE that omits WRITE_DAC/TERMINATE, non-elevated worker — **no**.
  Elevated (SeDebug) — **yes**. `taskkill /F` does NOT bypass OWNER_RIGHTS.
- **Test:** ✅ UTM VM — three runs (no-OWNER_RIGHTS bypassed; OWNER_RIGHTS+medium held;
  OWNER_RIGHTS+SeDebug bypassed).

### L3 — protected-set guard in every kill path (the invariant for our own code)
- **Prevents:** any kill from our code (lifecycle, port cleanup, diagnose) hitting a live
  protected process; a name-based "kill python" hitting the backend.
- **Enforced:** `partition_kill()` in `core/app_ports.py:329` (`kill_trees`),
  `instances/procs.py:53/92/130` (`kill_owned`/`terminate_tree`/`kill_port_if_owned`),
  `instances/ports.py:265` (`kill_allowed`), `utils/process_tree.py`
  (`kill_process_tree`), and Electron `uv-manager.js` (`_killPort:2448`,
  `_killChildTree:1973`, `_drainVenvProcesses:1512`).
- **Bypass:** not for code that calls it; a raw worker kill is caught by L1, not here.
- **Test:** ✅ harness (C3) · ⬜ unit `test_all_kill_paths_consult_guard`.

### L4 — Broker for legitimate kills
- **Prevents:** suicide while preserving cleanup — enumerate targets, subtract protected,
  kill the rest. Resolves "kill python": kills the user's, spares the backend.
- **Enforced:** new `flow_sdk/cli/proc_cmd.py` (`flow proc kill`), runs outside the sandbox.
- **Bypass:** the worker cannot skip it (raw kill blocked by L1); it can only ask.
- **Test:** ✅ harness (C3) · ⬜ unit.

### L5 — Command-sink guard (defense-in-depth)
- **Prevents:** running a worker command against a protected PID/port in
  `core/compute/exec.py:123` (`run_shell`), `builtin/shell.py:1597` (`run-command`),
  `:1632` (`run-detached`, which runs inside the backend, uncontained).
- **Bypass:** **yes** — shell parsing is defeatable (`sh -c`, verified on macOS). This is
  defense-in-depth only; the real boundary for the worker is L1.
- **Test:** ⬜.

### L6 — Peer-credential auth on sensitive endpoints
- **Prevents:** indirect disruption via HTTP — the worker reads `.cookie_gate`
  (`instance_settings/cookie_gate.py:75`, readable from disk) and calls destructive
  endpoints; or an actor impersonating the supervisor.
- **Enforced:** sensitive lifecycle/destructive endpoints authenticate the caller by
  kernel-attested peer identity — `GetNamedPipeClientProcessId` (Windows) /
  `SO_PEERCRED` (Unix) → open the peer, read its IL/image, refuse a contained worker
  **regardless of any token it presents**. (`flow stop` itself is a signal kill, blocked
  by L1, not HTTP.)
- **Bypass:** no — the client PID comes from the kernel, not from the client.
- **Test:** ✅ half (reading a peer's true IL demonstrated on the VM) · by construction
  (kernel-attested PID) · ⬜ full handshake → unit test.

### L7 — Registration sequence (discovery channel)
- **Prevents:** nothing itself; records who is protected for L3/L4.
- **Enforced:** `self_protection.registry` writes `runtime/<role>-<pid>.json` with
  create_time. Backend registers near the top of `server/app.py::_on_server_startup`
  (before the heavy boot work, and separate from `set_server_info` at `:168`); Monitor in
  `server/launch.py:594`; Electron in `main.js`; the transient lifecycle supervisor on
  start (it alone may call `release(pid, reason)`).
- **Bypass:** the worker does not read/write `runtime/` in normal flow; forge/delete is
  closed by L1 (write+rename deny on the dir AND its ancestors). create_time recheck
  closes PID reuse.
- **Test:** ✅ startup order confirmed against the code.

### L8 — Diagnosis-request agent containment + untrusted input
- **Prevents:** an agent spawned by a remote `DiagnosisRequest`
  (`builtin/diagnosis_request.py`) from killing/disrupting; and its `instructions`
  (`:61`) / attachments (SKILL/SUBAGENT/MARKDOWN/PROMPT, `:32`) as an injection surface.
- **Enforced:** the runner agent goes through the same L1 containment; `ask_before=False`
  (`:63`) is not a sole defense.
- **Bypass:** same as L1.
- **Test:** ⬜ (harness case pending).

### L9 — `flow-diagnose` skill softening (prompt, non-authoritative)
- **Prevents:** the skill telling the AI to kill the self-PID
  (`SKILL.md:359-363`, `catalog.md:18`).
- **Bypass:** **yes** — it is a prompt. This is cleanup, NOT the fix; the fix is L1–L4.
- **Test:** —.

### L10 — CDP / remote-debugging surface (top priority; bypasses L1/L2)
- **Prevents:** the worker closing/controlling Electron (or the carve-out browser) via a
  Chrome DevTools Protocol endpoint over loopback (`Browser.close`, `Runtime.evaluate`).
- **Why it is separate:** loopback TCP is not gated by integrity level, and loopback from
  Low IL works (verified). So L1/L2 do not cover it.
- **Enforced:** FlowPad's Electron strips `--remote-debugging-port`/`--inspect` from its
  own argv at startup (strip-and-warn); the browser carve-out and the `real-browser`
  skill use `--remote-debugging-pipe` (CDP over an fd/pipe handed only to the trusted
  driver), never a TCP loopback port.
- **Bypass:** no, if no loopback port exists; **yes** while a port is open.
- **Residual / note:** the committed source is clean — `electron/main.js:51` only appends
  a crash-report `enable-features` switch; there is no `--remote-debugging-port`. The live
  exposure found on the VM (`Flowpad.exe` on `127.0.0.1:9222`, no auth) came from a
  **launch flag** (`--remote-debugging-port=9222`), normalized by `docs/debugMCP-setup.md`
  and `real-browser/scripts/browser.mjs:98`, not from default behavior.
- **Test:** ✅ class confirmed live on the VM (open, unauthenticated, loopback-reachable) ·
  ✅ source confirmed clean (a launch flag, not default).

## 5. Windows isolation decision

**Low-IL worker by default + a Medium browser carve-out.** Chrome's browser process does
not run at Low IL (verified: same launch method, Medium → 12 procs + CDP serves; Low → 0
procs, exits immediately). So browser-driven skills do not launch Chrome themselves.
Instead a **browser helper** runs at Medium, spawned and owned by the backend (never the
worker), registered and OWNER_RIGHTS-protected; the Low worker drives it only via CDP over
a **pipe** (not a TCP port — L10). Reopened surface is bounded: CDP exposes page
automation + downloads (point downloads at a Low-labeled dir), not OS process spawn/kill.

## 6. `FLOWPAD_EXECUTION_SCOPE` (existing)

A worker's `flow` commands carry `FLOWPAD_EXECUTION_SCOPE`
(`cli_drivers/cli_worker_base_driver.py:476`), a JSON identity of its own
`agentic_process`, resolved by the backend (`tasks/identity.py`), "never claimed". A
lifecycle-verb refusal can use it ("a worker targeting its own instance"), but the worker
can unset it, so it is defense-in-depth, not a boundary.

## 7. Verification summary

| Claim | Where | Status |
|---|---|---|
| DACL alone bypassed; DACL+OWNER_RIGHTS holds (non-elevated); SeDebug bypasses | UTM VM | ✅ |
| Low-IL blocks kill + WM_CLOSE + medium-dir writes; node/dev-server/loopback work | UTM VM | ✅ |
| Chrome dies at Low IL (Medium control serves CDP) | UTM VM | ✅ |
| macOS write-allowlist closes ancestor-rename; deny-list does not | macOS sandbox | ✅ |
| peer-cred: reading a peer's true IL works; kernel-attested PID | UTM VM + construction | ✅ half |
| CDP loopback bypasses IL/DACL; live via launch flag; source clean | UTM VM + source | ✅ |
| Invariant end-to-end (kill / name-kill / broker / CDP), OS vs app block | macOS harness 6/6 | ✅ |

## 8. Open items

- **Linux** — unverified (no VM): bwrap + user/pid namespaces; the `systemctl --user kill`
  bypass (hide the user D-Bus socket from the sandbox).
- **Full peer-cred handshake** — unit test at implementation.
- **Implementation go-ahead** — gated on explicit approval ("do not implement yet").

## 9. Implementation order (when approved)

1. L0 + L7 — protected-set and registration.
2. L3 + L4 — guard in every kill path, and the broker (closes the invariant for our code:
   lifecycle, `_killPort`, diagnose, "kill python").
3. L1 — OS containment (the non-compliant worker + diagnosis-request agent).
4. L10 — strip remote-debugging; CDP over pipe.
5. L5 + L6 — defense-in-depth and peer-cred.
6. Gates — a policy test that every kill path calls `partition_kill` and every spawn site
   calls `contain_agent_argv`, in the style of
   `tests/unit/test_data_sources_are_self_contained.py`.
