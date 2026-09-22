---
id: 0d9157ba-e30c-5da0-a42f-87b215d6a4ab
name: flowpad-navigation
description: Shows a file, entity or screen to the user in Flowpad with `flow show`,
  or moves their browser tab with `flow navigate` when they explicitly ask to be taken
  somewhere. Use whenever the user asks to open, show, display, preview or jump to a
  file path, TypeId or screen — including bare follow-ups such as "open it" or "show
  it" after creating or discussing a file — and to show a code snippet the user can
  run (`flow show snippet`). Never use the operating system's `open`
  command for this; Flowpad has its own surface. NOT for building the deliverable
  itself (building-deliverables), or creating and indexing records
  (flowpad-assistance).
---

# flowpad-navigation

**Act now. Do not research how to show or navigate — the recipe is right here. Never
read other skill files, never `ls` the skills dir, never write a report.** This is one
side-effect the user sees in their browser; it is a few commands, not an investigation.

**Never open the target with the operating system** (`open`, `xdg-open`, `start`) or a
browser. That puts the file outside Flowpad, where the user cannot act on it.

## The decision rule — `flow show` vs `flow navigate`

Key on the **intent**, not on the mode and not on who authored the file:

- **"Here is the thing"** — presenting, handing over, or simply making something
  visible → **`flow show`**, in every mode. It never navigates: in a vibe session it
  pins the display pane; in any other mode it opens the target as a tab right after
  your process and marks your chip. A background agent therefore cannot interrupt
  anyone. **This is the default, and it is what a bare "open it" means.**
- **"Take me there"** — the user explicitly asks to jump to / go to / be taken to
  something → **`flow navigate`**. It moves the tab the user is looking at, so use it
  only when being moved is what they asked for.

When in doubt, `flow show` — the failure mode of showing is a tab the user ignores;
the failure mode of navigating is yanking them out of their work.

## You have a file path

This is "open it" after writing or discussing a file. No TypeId, no indexing needed:

```bash
flow show file <absolute-path>
```

Exit 0 = shown, done.

Only if the user explicitly asked to be *taken* to it does the file need an entity
first. Two commands, no research:

```bash
flow record index <absolute-path> --types markdown   # returns data.typeid
flow navigate entity <data.typeid>
```

`flow record index` is path-scoped and fast; its JSON carries `data.typeid`
(e.g. `markdown-<uuid>`). Pass it straight through — no search, no guessing.

## A code snippet to see and run

When you and the user are working on a piece of code they should see **and run**,
show it as a snippet: one code file split by comment markers into regions. Imports
and setup stay folded away; the snippet view has a Run button with the output below.

```bash
flow show snippet --lang py --name load-data <<'SNIP'
# %% flowpad:hidden
import json
# %% flowpad:init
data = {"a": 1}
# %% flowpad:snippet
print(json.dumps(data))
SNIP
```

- Markers: `# %% flowpad:hidden` (imports), `# %% flowpad:init` (setup),
  `# %% flowpad:snippet` (what the user sees). Use `//` for js and rs. Without a
  `flowpad:snippet` marker the command refuses (exit 2).
- `--lang` is the file extension: `py`, `js`, `rs`, `sh`. With no PATH the code is
  read from stdin into the OS temp dir; the JSON answer's `path` is that file. To
  change it on a later turn, edit that file, then run `flow show snippet <path>` again
  so the view reloads it — the view does not watch the file. An existing file:
  `flow show snippet <path>` (on an explicit "take me there", `flow navigate file <path>`
  opens the same snippet view).
- The file runs top to bottom **as written** — the markers are only comments, so the
  whole file must be a complete, valid program. A compiled language needs its entry
  point: in rust, `fn main() { ... }` goes inside the snippet region (bare statements
  do not compile).
- Run it yourself exactly as the Run button does, and read the result before you
  claim it works:

```bash
flow snippet run <path> --timeout 30   # JSON stdout/stderr; exit = the snippet's own, 124 on timeout
```

- A run that never ends is killed at its timeout (the Run button's is a preference,
  30s by default), keeping whatever it printed. Nobody has to stop it by hand; stdin
  is closed, so `input()` fails instead of waiting.

## You already have a TypeId

A TypeId has the shape `<type>-<id>` (`shell-<uuid>`, `markdown-<uuid>`, `task-<uuid>`).
Run exactly one command, then stop:

```bash
flow show entity <typeid>       # presenting it — the default
flow navigate entity <typeid>   # only on an explicit "take me there"
```

## A running web app you started

```bash
flow show webapp --port <port>
```

Use the port the dev server actually reported, never an assumed one.

## A screen

Screens are addressed by **view name**, optionally plus `/pointer` and `?opts` — the
same string the URL bar carries after `/dock/`. Not by TypeId:

```bash
flow show view events                       # presenting it — the default
flow show view assets/list/skill
flow show view "search?q=widget"            # quote anything containing a ?
flow navigate view preferences/appearance   # only on an explicit "take me there"
```

**Find the screen in the table below — do not reason from the address.** The address is
a slug and the user speaks English; several slugs read nothing like the screen they open
(`rag` is Search indexes, `explorer` is Files, `project` is Collaboration). Match on the
**Screen** or **also called** column, then copy the address verbatim. If the ask matches
no row, say so and ask which screen — a near-miss address is not a near-miss result, it
opens a different screen and reports success.

### Open by name

| Screen | address | also called |
| --- | --- | --- |
| AI Configuration | `ai-config` | ai config, llm apis, models, clis |
| Artifacts | `artifacts` | deliverables |
| Assets | `assets` | library, docs tree |
| Assistance | `assistance` | expert assistance |
| Capabilities | `capabilities` | checks, system checks |
| Code Editor | `editor` | edit file |
| Collaboration | `project` | room |
| Credentials | `credentials` | connections, secrets, api keys, keys, env vars |
| Data sources | `data-sources` | connectors, integrations, ingestion, sources |
| Desktop | `desktop` | favorites |
| Docs | `docs` | documentation |
| Events | `events` | rules, event bus, triggers, signals, cron |
| Files | `explorer` | file tree, folders |
| Graph Workflows | `graph-workflows` | workflows |
| Home | `home` | landing, start |
| Hooks | `hooks` | claude hooks |
| Stream Inbox | `stream_inbox` | messages |
| LLM Endpoints  *(hub)* | `llm-endpoints` | endpoints |
| LLM sources | `llm-sources` | harness funding |
| Set up LLM | `llm-setup` | llm setup, choose llm, connect llm |
| Machine | `machine` | system, this machine |
| Markdown | `markdown` | document |
| Organization  *(hub)* | `organization` | people, teams, members |
| Preferences | `preferences` | my preferences, appearance |
| Runs | `process-runs` | history |
| Search | `search` | find |
| Search indexes | `rag` | embeddings, knowledge index, vector index |
| Settings | `settings` | claude settings |
| Survey | `survey` | — |
| System Profile | `system_profile` | claude code status, live status |
| Tasks | `tasks` | todo |
| Token plan  *(hub)* | `token-plan` | budget, token budget |
| Web App | `web-app` | web apps |
| Worker | `shell` | chats, terminal |

### Need an id

These take a pointer; without one they are an error, not a landing. Get the id first
(`flow record index`, or the `search` action of **flowpad-assistance**).

| Screen | address | also called |
| --- | --- | --- |
| Agent | `agent/<id>` | — |
| App | `app/<id>` | — |
| Context | `graph_context/<id>` | frozen context |
| Conversation | `conversation/<id>` | — |
| Diagnosis | `diagnosis/<id>` | — |
| Diff Viewer | `diff/<id>` | changes |
| Entity  *(hub)* | `entity/<id>` | hub entity |
| Graph | `graph/<id>` | dep graph, dependency graph |
| Help desk | `helpdesk/<id>` | support |
| Knowledge Browser | `k-browser/<id>` | docs browser |
| Lens | `lens/<id>` | transcript |
| Live Session | `live_session/<id>` | — |
| Plan | `plan/<id>` | — |
| Process | `agentic_process/<id>` | — |
| Records  *(hub)* | `records/<id>` | hub records |
| Show | `show/<id>` | — |
| Ask | `ask/<id>` | — |
| Skill apps | `apps/<id>` | — |
| Spec | `spec/<id>` | — |
| Subgraph | `subgraph/<id>` | — |
| Tag Graph | `tag/<id>` | tags, taxonomy |
| WorldView | `worldview/<id>` | world, org graph |

A screen marked *(hub)* lives on the hub surface — address it as `hub/<view>`.

`flow schema views` is the same table, live, with each view's pointer rule. Reach for it
only if the ask matches nothing above. Screens are **not** TypeIds: `flow navigate entity
events` is wrong and will fail.

## You have no path and no id

- **"the current X"** → the `context` action of the **flowpad-assistance** skill maps
  the user's phrase to a key; show the TypeId it returns.
- **You know only a name** → the `search` action of the same skill, which owns what to
  do when several rows match; show the TypeId it settles on.

Do not invent a TypeId and do not ask the user — that is what those actions are for.

## Exit codes

On success the CLI prints one JSON line to stdout and exits 0:

```json
{"ok": true, "connection_id": "...", "type": "...", "id": "..."}
```

| Exit | Meaning |
| ---- | ------- |
| `0`  | Done. Stop — no verification, no summary. |
| `2`  | Bad argument (invalid TypeId, unknown view, or a view missing its pointer). Fix the argument. |
| `3`  | No active browser tab (`flow navigate` only). Tell the user to open Flowpad. |
| `4`  | Entity or pointer not found — well-formed but does not exist. Tell the user. |
| `5`  | Cannot reach the Flowpad server. Tell the user the server is down. |
