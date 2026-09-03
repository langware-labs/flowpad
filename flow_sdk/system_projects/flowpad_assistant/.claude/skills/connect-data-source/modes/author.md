# Mode: author — write a NEW source type

> **Ground rules (inline by design):**
> **1. Evidence, never events.** A 200 is not proof; `poll_now` only marks a
> source due, so "I polled" is never "items landed".
> **2. Read before you poke** — `poll_now` clears `health`, `error_code` and
> `error_detail` together.
> **3. Never widen a wait, a timeout, or a retry to make something pass.**
> **4. Never destroy the user's data to fix a symptom.**
> **5. Credentials and invites are the user's step** — name the exact click.

Reached when no installed spec can express what the user named. The output is a
folder asset, not SDK code — nothing is edited in `flow_sdk`.

`SC` means `python3 <this skill>/scripts/source_ctl.py`.

## What you are writing

```
<project>/agentic-assets/data_source/<name>/
    data_source.json    the manifest — presentation + the config form
    fetch.py            the module that actually reads the system
```

The runtime is derived from the folder, never declared: `fetch.py` ⇒ script,
neither ⇒ a builtin resolved by `name`. `FETCH.md` is **reserved and refused at
load** (`ManifestError`), so write `fetch.py`. A source that should fetch through a worker is not authored
at all: it is the shipped `agent` transport, configured per
`references/mapping.md`. Read `docs/data-management/data-source-asset.md` for the manifest
rules before writing one; the ones that bite:

- `name` must not collide with an installed source — a collision is refused and
  the folder is ignored.
- `icon_name`, never `icon`.
- `auth` is `{connector, scopes}` **or** `{env: [...]}`, never both, and never a
  credential value.
- A `traits` block is REQUIRED for an authored source (it is what a builtin's
  driver class would hold) and forbidden on a builtin. At minimum `emits` — the
  ontology kind stamped on every record; the loader refuses a `fetch.py` folder
  whose `emits` is missing or blank, and the folder is not indexed.
- `config` field `type` is one of `text` `lines` `csv` `number` `path`. Anything
  else is a load error.

## The module contract

`fetch.py` is invoked as `<python> fetch.py <verb> --request <path>`, reads that
JSON file, and prints one JSON object. Exit `0` ok, `3` config failure (a person
must fix it), `4` transient (retry next tick). stderr is captured for the author
and never parsed.

Request, every verb:
```json
{ "protocol": 1,
  "source": { "id": "...", "name": "...", "account_key": "...",
              "config": { }, "window_days": 7 } }
```
`fetch` additionally gets
`"cursor": {"segment_key": "...", "state": {}, "window_start": "...", "first_run": true}`.

Responses:
- `segments` → `{"segments": [{"key": "...", "label": "..."}]}`
- `fetch` → `{"items": [...], "state": {...}, "unchanged": false}`; an item needs
  at least `external_id`, plus `title`, `body`, `occurred_at`, `permalink`,
  `author_display` as available.
- `verify` (only if the manifest sets `setup_wiki`) →
  `{"ready": false, "detail": "a sentence for the user", "pending": [...]}`

**Two rules that cause silent data loss if ignored:**
1. **Omitting `state` carries the previous one forward; `{}` CLEARS it.** Return
   your position every time you have one.
2. **Never send `source_id`, `provider`, `kind` or `segment_key` on an item** —
   the host stamps them, and they are ignored. That is what stops one source
   writing records attributed to another.

Use the standard library only unless the user accepts a dependency; the module
runs as a plain subprocess with no package management.

## Shipping an editor with the source

A definition's editor is a **webapp asset nested inside the definition** —
nothing more. Put it at `<spec folder>/agentic-assets/webapp/editor/`:

```
<spec folder>/data_source.json
<spec folder>/agentic-assets/webapp/editor/webapp.json   {"name":"editor","kind":"application.web.editor","build":"."}
<spec folder>/agentic-assets/webapp/editor/index.html
<spec folder>/agentic-assets/webapp/editor/app.js        import { mountSourceEditor } from '/sdk/flowpad-sdk.js'; mountSourceEditor();
```

Nothing registers it: a nested asset is a child of the asset it sits in, so
re-indexing makes it the definition's app. `kind: application.web.editor` is
what makes the Data Sources menu offer "Open editor"; the app is served and
addressed like any other webapp (`/dock/app/micro_app-<id>`), and its address
bar reads `Project / <definition> / editor`.

`mountSourceEditor()` is the shipped editor (config form + items + dataset
pane) — the nine bundled definitions each carry those three lines. To write a
different one, copy `web-app-builder/template-flowpad` into that folder instead
and call `sdk.resolveAppHost()`; its `subject` is the definition you are editing.
A definition with no such folder simply has no editor.

## After writing

1. `flow record index <project> --types data_source_spec` — point it at the
   PROJECT, not the source folder.
2. `SC specs` — the new name must appear. If it does not, the manifest was
   rejected; the backend log names the rule.
3. Create the source and run the five gates in `modes/connect.md`.
4. **The runtime probe.** If the test gate stalls with `unknown_provider`, the
   spec is written and indexed but no runtime picked it up. Say exactly that —
   never report a source as connected when it has never run.
