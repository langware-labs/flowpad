---
id: e78ff2be-fe49-4c63-bf05-122dc3a3a36f
title: A process declares its persona; the renderer never infers one
tags:
- breadcrumb.test.declared_persona.rules
description: A vibe session answered as data-integrations, or as no one at all ("I
  am Claude Code"), because the "you are this agent" directive was emitted only when
  EXACTLY ONE agent was embedded. Identity is now declared by the caller via set_ap_persona
  and stored on process_persona_path; count and embed order carry no meaning.
---

# A process declares its persona; the renderer never infers one

> Ground truth. Proven by RCA on 2026-09-08. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.declared_persona.rules
sites:
  - rel_path: "tests/unit/test_system_instruction_assets.py"
    line: 150
    note: "FAILING? the persona is DECLARED via set_ap_persona, never inferred from how many agents are embedded - read this tag's rules before touching _render_agents_instruction_block or process_persona_path"
  - rel_path: "tests/unit/test_system_instruction_assets.py"
    line: 213
    note: "FAILING? an UNDECLARED agent must never inherit the 'you are this agent' directive - a failed persona embed loses the identity, it does not hand it to whoever is there. Read this tag's rules."
```

## Expected behavior

A chat session answers as the persona the UI asked for — `vibe` in vibe mode,
`standard` in a plain chat — and keeps answering as it for every reply.

Embedding a *second* sub-agent must not change who the session is. Vibe mode
routinely embeds the `vibe` persona **and** every in-scope `kind: vibe` layer on
top of it; those layers are capabilities the persona may draw on, never
candidates for the identity.

A process with **no** declared persona — a terminal process, the normal case —
must have none inferred for it. The worker keeps its own identity, and the
embedded agents render as a flat, co-equal catalogue.

## Internals

* **Identity is a field, not a count.** `AgenticProcess.process_persona_path`
  (`flow_sdk/builtin/agentic_process/agentic_process.py:1149`) holds the
  assets-dir-relative path of the materialized sub-agent that IS the process's
  persona (e.g. `.claude/agents/vibe.md`); `None` means no persona.

* **It is a path, not a TypeId, and that is deliberate.** The materialized
  copy's entity id is minted by the indexer *after* the file is written, so it
  does not exist when the embed action runs, and it is re-minted on every
  rewrite. A TypeId would be both unavailable and unstable. The filename stem is
  the agent name, which is exactly how `agents_json` is keyed.

* **The caller declares it.** `load_embedded_subagent_action`
  (`:5224`) takes `set_ap_persona: bool = False` and writes
  `self.process_persona_path = rel.as_posix()` at `:5277` only when it is true.
  The frontend passes it for the two base personas and *not* for the layers:
  `embedVibeSubagent` (`ui/src/pages/flow-page/use-start-vibe-session.ts:69`)
  and `embedStandardAgent` (`ui/src/navigation/embed-standard-agent.ts:36`) pass
  `true`; `systemVibeKindSubagentRefs` (`use-start-vibe-session.ts:95`) and the
  per-agent embed at `:106` do not. `AgenticProcess.loadEmbeddedSubagent`
  (`ts_sdk/src/process/agentic-process.ts:2232`) is the seam that carries the
  flag over the wire as `set_ap_persona`.

* **The renderer promotes the named agent and nests the rest.**
  `_render_agents_instruction_block(agents_json, persona_path)` (`:5644`)
  resolves `persona = Path(persona_path).stem`, then splits:
  `_render_persona_section` (`:5570`) emits the `# You are the '<name>' agent`
  directive plus that agent's description and instructions;
  `_render_subagent_sections` (`:5599`) emits everything else under
  `# Sub-agents available to you`, whose preamble states explicitly that those
  blocks do NOT replace the persona and must never be introduced as the
  speaker's identity.

* **The flat catalogue is the no-persona rendering, not a fallback for "many".**
  With `persona is None`, `_render_subagent_sections` emits
  `# Embedded agent specs` — co-equal blocks, no identity directive. This is the
  correct output for a terminal process, and it is also what a *failed* persona
  embed degrades to.

* **Call site.** `prepare_system_instruction_assets` reaches the renderer
  through `:5724`, passing `self.process_persona_path` alongside the merged
  `agents` dict built at `:5723`.

## Invariants

* **Declared, never inferred.** Nothing may derive the persona from
  `len(agents_json)`, from dict/embed order, or from `.claude/agents/*.md` mtime.
  The old positional coupling is gone on purpose: identity no longer depends on
  mtime ordering, so the concurrent-write race and the alphabetical tiebreak
  (`data-integrations` < `vibe`) are no longer correctness hazards.

* **A declared-but-absent persona loses the identity; it never hands it over.**
  When `persona not in agents_json` (`:5658`) the renderer logs and falls back to
  `persona = None` — the flat catalogue. A failed embed must **lose** the
  identity, not promote whichever agent happens to be there.

* **Exactly one agent may carry the directive**, and only the declared one.
  A layer that did not ask to be the persona must never render
  `# You are the '<name>' agent`.

* **Failures are audible.** Both embed failures — file missing and unparseable —
  log a warning naming the process, the path, and `(persona NOT set)`
  (`:5259`, `:5266`), as does the render-time divergence. A session used to lose
  its persona leaving no trace anywhere except the model's own self-description;
  that silence is what made this expensive to diagnose.

## Failure modes

The proven on/off lever is the persona resolution at `:5657`. Replacing

```python
persona = Path(persona_path).stem if persona_path else None
```

with the pre-fix count-based inference

```python
persona = next(iter(agents_json)) if len(agents_json) == 1 else None
```

reproduces both symptoms exactly, and restoring it clears both:

* **Two agents embedded → nobody is the persona.** `len == 2` falls through to
  `# Embedded agent specs`. No block claims the identity, so the session keeps
  the harness's own — the reported *"אני קלוד קוד" / "I am Claude Code"*. Two
  personas have been embedded since `b1150f0bf` shipped `data-integrations`,
  which is when this latent branch became reachable.

* **One agent embedded → it inherits an identity it never asked for.** When
  `vibe.md` failed to embed, `data-integrations` was the only entry, `len == 1`
  held, and it took the directive legitimately — hence *"This falls outside my
  scope — I'm the data-integrations persona."* The undeclared-agent test pins
  this direction.

**Not covered here:** *why* `vibe.md` itself failed to embed for 13 processes
is unproven and tracked separately. These rules make that failure degrade
honestly — no persona, and now a log line — but they are not a fix for it.
