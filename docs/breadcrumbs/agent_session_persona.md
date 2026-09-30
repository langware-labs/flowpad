---
id: ba4f3544-b10b-4544-b40b-094e421aa626
title: An agent session keeps the agent as its identity
tags:
- breadcrumb.test.agent_session_persona.rules
description: A mail-assistant Agent auto-launched on an e2b box answered as vibe,
  because prepareAgentSession embedded vibe with set_ap_persona=true, so CLAUDE.md
  appended "You are the 'vibe' agent … for every reply" after the agent's own prompt.
  Agent sessions now embed vibe as a layer (asPersona false); the agent's system_prompt
  is the identity.
---
# An agent session keeps the agent as its identity

> Ground truth. Proven by RCA on 2026-09-16. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.agent_session_persona.rules
sites:
  - rel_path: "ui/tests/api/agent_use_keeps_agent_persona.test.ts"
    line: 46
    note: "FAILING? an agent session must keep the AGENT as its identity - prepareAgentSession embeds vibe with asPersona:false. Read this tag's rules before touching embedVibeSubagent or set_ap_persona."
  - rel_path: "ui/tests/e2e/agent-auto-launch/agent_auto_launch_persona.spec.ts"
    line: 101
    note: "FAILING? the auto-launched agent must answer as itself, not as vibe - read this tag's rules (and its open item on the vibe layer's capability pitch) before editing."
```

Builds on [declared_persona](declared_persona.md) — the renderer never infers a
persona; every embed call site declares it. This doc pins which side the
**agent-launch** call site must be on.

## Expected behavior

A session opened **as an Agent** — the "Use" button or the project auto-launch
redirect — answers as that agent for every reply. Asked "hi, whats your job", a
mail-assistant agent says it is the mail assistant, not the Flowpad creator.

The session still carries vibe's display contract (`flow show`, the display
pane), because it opens in the vibe workspace. Vibe rides as a **layer** under
the agent; it is not the identity.

## Internals

Both entry points create the process through the same backend call and prepare
it through the same UI function:

| step | where |
| --- | --- |
| Auto-launch: `POST /api/v1/agents/auto-launch` | `flow_sdk/server/routes/agents.py:34` → `Agent.auto_launch_for` (`flow_sdk/builtin/agent.py:449`) → `winner.use(...)` (`:484`) |
| Use button: `POST /agent/<id>/use` | `Agent.use_action` (`flow_sdk/builtin/agent.py:1101`) |
| Both → `Deployment.use()` | writes the agent's `system_prompt` into `context_data.instructions` (`flow_sdk/builtin/deployment.py:584`), sets `launched_by_agent = agent.name` (`:587`), appends the output-folder line (`:774`). `process_persona_path` is left unset. |
| UI prepare, both paths | `prepareAgentSession` (`ui/src/components/agents/use-agent-launcher.ts:39`), called by `useAgentLauncher` and by `agentAutoLaunchRedirect` (`ui/src/agents/agent-auto-launch-redirect.ts:61`) |
| Vibe embed | `embedVibeSubagent(proc, { asPersona })` (`ui/src/pages/flow-page/use-start-vibe-session.ts:69`) → `proc.loadEmbeddedSubagent(vibeRef, asPersona)` (`:77`) → `ts_sdk/src/process/agentic-process.ts:2273` posts `set_ap_persona` |
| Persona write | `ProcessAssets.load_embedded_subagent_action` writes `process_persona_path = ".claude/agents/vibe.md"` only `if set_ap_persona` (`flow_sdk/builtin/agentic_process/process_assets.py:84`) |
| Render | `_prepare_system_instruction_assets` (`process_assets.py:335`) joins `resolve_system_instructions()` (`agentic_process.py:6537`, i.e. `context_data.instructions` first) with `_render_agents_instruction_block(agents, process_persona_path)` (`process_assets.py:349`, `:295`). A declared persona renders `_render_persona_section` (`:219`): `# You are the '<name>' agent … for every reply`. |

The agent's prompt is always **first** in `CLAUDE.md`; the persona block, if any,
comesh **after** it. The worker gets the file trough
`--append-system-prompt-file …/execution/assets/CLAUDE.md`.

## Invariants

* **In an agent session the agent's `system_prompt` is the identity.**
  `prepareAgentSession` calls `embedVibeSubagent(proc, { asPersona: false })`
  (`use-agent-launcher.ts:47`). `process_persona_path` stays unset, and CLAUDE.md
  renders vibe and the other layers under `# Embedded agent specs`, with no
  `# You are the '…' agent` directive.
* **Plain vibe sessions are unchanged.** `asPersona` defaults to `true`; every
  other `embedVibeSubagent` caller (vibe home launcher, `vibe-chat-pane`) still
  declares vibe as the persona.
* **Use and auto-launch cannot diverge.** Both go through `prepareAgentSession`;
  a fix for one is a fix for both. Don't add a second embed call on either path.

## Failure modes

**The proven lever** is the second argument of the vibe embed on the agent path
(`loadEmbeddedSubagent(vibeRef, <flag>)`), checked with the api test:

* `true` → `process_persona_path = .claude/agents/vibe.md` → CLAUDE.md = agent
  prompt + `# You are the 'vibe' agent … Adopt the persona … for every reply` →
  the test fails (`expected 'You are MAILBOT_PROBE…' not to contain "# You are the 'vibe' agent"`).
* `false` → no persona block → the test passes.
* Back to `true` → it fails again.

Observed symptom before the fix (e2b sandbox, flowpad 0.2.168,
`anthropic/claude-haiku-4.5`): the auto-launched mail assistant replied as vibe.
In the local e2e (claude-opus-5) the reply opened "In this workspace I can also
build things you describe, like websites … in the display pane".

**Open — not covered by the fix.** With vibe as a layer, its full instructions
are still in CLAUDE.md, and its body begins "You are the builder behind
Flowpad's vibe workspace". After the fix the agent introduces itself correctly
("I'm MAILBOT_PROBE, an email assistant…") but can still add "I can build
things like apps … and show them in the display pane". The e2e reply check
(`VIBE_PITCH`) fails on that. Whether an agent session should carry only vibe's
display contract instead of its full body is undecided.

**Separate, unproven:** in some local runs the Claude worker exited ~40–60 ms
after launch (`stdin prompt write failed: Connection lost`, no debug file), so
the turn never answered. Replaying the identical argv/env by hand worked, and a
fresh backend usually worked. Cause not found; it is not part of these rules.
