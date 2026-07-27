---
id: 8781a40e-9211-426c-990f-875d8558cace
title: Sub agents
---

# Sub agents

A **sub agent** is a Claude Code subagent — a named agent with its own system
prompt that a session can delegate work to. The main session stays in charge;
it hands a task to the sub agent, which works separately and reports back.

On disk it's a single markdown file: `.claude/agents/<name>.md`. The
frontmatter carries the agent's `name` and a `description`; the body is the
agent's **system prompt** — who it is and how it should work. Creating one asks
for a name and opens the editor with the cursor at the start of the prompt.

Like a skill's description, the `description` is what decides when the agent
gets picked, so write it as a trigger: what kind of task this agent is for.

## When to use one

Reach for a sub agent when work is worth doing in a separate context — a broad
search across many files where you only want the conclusion, a review pass with
its own standards, or several independent pieces of work you want running at
once. Reach for a [[Skill assets|skill]] instead when what you're packaging is
a *procedure* the main session should follow itself.

## Where it lives

A sub agent created with a project active belongs to that [[Flowpad project]].
With no project active it goes to your home folder, where every project can see
it.

## Good to know

- **It's a Claude Code concept.** Sub agents are read by the `claude` CLI. A
  [[Codex sessions|Codex]] or [[Copilot sessions|Copilot]] session won't pick
  them up.
- **A sub agent is just a file.** Edit it in any tool, commit it, or share it
  into a conversation like any other asset — including [[Git sharing]] when it
  lives in a repository.
