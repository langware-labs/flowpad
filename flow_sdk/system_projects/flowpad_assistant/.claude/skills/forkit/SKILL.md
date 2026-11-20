---
id: 1f2756ca-8822-4ee1-87c0-7e100fbf8882
name: forkit
description: Works a list of issues in parallel — one fork of a root session per issue
  — from one small app. The issues on the left (Open / Done / All, a short description
  behind ⓘ, ✓ Done / ↺ Open per row), the selected issue's live fork terminal in the
  centre. Use for "forkit these issues", "fork a session per issue", "work this list
  in parallel forks", or after a review / pentest / triage produced a list to work
  through. NOT for spawning unrelated subagents (Agent tool), a task ledger (task-management),
  or a mock of a UI (mockify).
---

# forkit — one fork per issue, one screen to work them

The root session already knows the issues (it found them). forkit forks it once per issue, so every fork
starts with that whole context and one instruction: work this issue only. The list and each issue's status are
data (`forkit.issue` rows), so the app, another window or an agent all see the same state.

## Behaviour

- Picking an issue starts nothing. The centre shows the fork's **first message** and **Start fork**. The message
  comes from the run's template in the header — default `lets focus on issue {identifier}`, editable there — and
  can still be edited per issue before Start. On Start the fork is made (`agentic_process/<root>/fork`, then `/open`
  with that message) and goes straight to work on that issue. Two clicks never make two forks.
- **✓ Done** closes the fork (`/close`) and marks the issue done. **↺ Open** reopens it; opening it again makes a
  new fork from the root.
- The centre is the fork's own terminal (`/win/shell/agentic_process-<id>`), live; type into it.
- Works on any worker: the forks run where the root runs. A root on another machine (`hub_route`) is refused —
  run forkit on the machine that runs it.

## Run it

1. Write `issues.json` (in your scratch folder):
   ```json
   {"root": "<agentic_process id>", "title": "pentest 2026-11-20",
    "issues": [{"id": "60", "title": "Admin can raise a public-deployment cap",
                "desc": "Two or three lines: what is wrong, where.", "prompt": "optional — the fork's first instruction"}]}
   ```
   - `root`: the session to fork — usually YOUR process:
     `python3 -c 'import json,os;print(json.loads(os.environ["FLOWPAD_EXECUTION_SCOPE"])[0]["id"])'`.
   - `desc`: what the issue is about, in plain words; it is what the person reads behind ⓘ.
   - `prompt`: leave it out — the page's template gives the first message (the fork already holds the whole
     conversation). Write one only when THIS issue needs a message of its own; it then ignores the template.
2. `"$FLOWPAD_PYTHON" -I <this skill>/scripts/forkit.py issues.json` → `{ok, slug, issues, page}`.
   Re-running the same title keeps every issue's status and fork; issues no longer listed are removed.
3. `flow show file <page>`.

Reply with: how many issues, the root, that a fork starts when the person approves its first message, and that ✓ Done closes it.

Page code follows the **flow-js** skill (the terminal frame carries the page-state key).

## Where things are

- The page: ONE file, `forkit.html` in this skill; each run is a copy with its run filled in, `<home>/forkit-<slug>.html`.
- The kind: `forkit.issue`, shipped by Flowpad (`flowpad_assistant/agentic-assets/data_schema/forkit.issue`) — nothing to apply.
- The rows: the `issues` dataset of the forkit project, `<workspace root>/forkit` (`FORKIT_HOME` overrides; never under
  `~/.flow`); every run, key `<slug>--<issue id>`. Read or fix them with the data-management skill's `dm_ctl`
  (`ds-rows <home>/agentic-assets/dataset/issues --match '{"input.run": "<slug>"}'`); never edit row files by hand.
