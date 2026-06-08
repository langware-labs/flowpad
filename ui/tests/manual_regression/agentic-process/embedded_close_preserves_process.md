---
id: 5f60991e-d10f-5b95-a1fb-08d34e2b2a66
---

> TEST-ISSUE (2026-06-04): This scenario depends on a ProcessToolbar rendered in
> **embedded mode** (the sidecar / side-window / EntityChatPanel side view that
> passes `embedded={true}`). In the current UI **no live caller passes
> `embedded={true}`** to InteractiveTerminal/ProcessToolbar — the `embedded` prop
> is plumbed through (InteractiveTerminal.tsx → ProcessToolbar.tsx) but dead. The
> embedded Close (X) button, and the hiding of Fork/Open-Terminal/Worktree/
> CommitMerge, therefore cannot be reached through any current UI surface, so the
> scenario's preconditions are unreachable. The DESIGN INVARIANT below
> (embedded close = pure onClose callback, no process.exit/close) still holds in
> the code, but there is no host to exercise it end-to-end. Re-enable this
> scenario once an embedded ProcessToolbar host ships again.

test 1: Close button in embedded ProcessToolbar hides the sidecar without terminating the process
- open a context where ProcessToolbar is rendered in embedded mode (the sidecar / side-window surfaces — e.g. collaboration page, EntityChatPanel side view, or any caller that passes embedded={true})
- validate the embedded ProcessToolbar does NOT render Fork / Open-Terminal / CommitMerge / Open-in-Worktree buttons (those are gated on !embedded)
- validate the embedded ProcessToolbar DOES render the Close (X) button
- capture the process id and current workerStatus
- click the Close (X) button
- validate the sidecar / side-window closes (unmounts)
- via an independent surface (main tabs view, /dock/home active processes list, or AgenticProcess cache inspection), validate the underlying AgenticProcess is still alive:
  - the process id still exists
  - workerStatus is unchanged
  - no /exit or /close HTTP action was issued (check Network tab)
- reopen the process via its main tab; validate the xterm state is intact

DESIGN INVARIANT (locked by this scenario): embedded close is a pure UI callback (onClose prop);
it does NOT call process.exit() or process.close(). Destructive teardown only happens from the
main-tab close/kebab menu.
