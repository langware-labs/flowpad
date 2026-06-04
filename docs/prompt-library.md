---
id: 6d726bd7-5dac-5bce-8812-6509f0779843
---

# Prompt Library — managed prompts, foldered, one click to queue

A library of reusable prompts, organized in folders, opened from the terminal
bottom ribbon next to the Queue: clicking a prompt enqueues it onto the
process's prompt queue (`prompt_queue.md`). Folders are **entities groups**
(`entities-groups.md`) — this feature contains zero folder logic; it only
composes the generic layer.

## Prompt entity

New record type `prompt` (the standard pairing: schema type +
`builtin/prompt.py` + `schema/type_info/prompt_info.py`).

Record layout: **markdown file** — frontmatter for metadata, body is the
prompt text. FS-editable, indexable, diffable like skills/docs.

```markdown
---
id: <uuid v4/v5>
name: Review my diff          # required
icon: search                  # optional
color: "#7aa2f7"              # optional
queue:                        # optional, reserved — see "Enqueue flags"
  clear_first: false
  ensure_enabled: true
---
Review the current branch diff for correctness bugs only. ...
```

Required: `name` + body text. Everything else optional. Ordinary entity in
every other respect — `project_id` scope, `group_id` membership, indexing,
nothing special.

### Enqueue flags (spec'd now, implemented v1.1)

The `queue:` frontmatter block is the reserved shape for per-prompt enqueue
behavior, honored by the backend enqueue path when present:

| flag | effect on enqueue |
|---|---|
| `clear_first` | clear the queue before adding |
| `ensure_enabled` | flip queue `enabled` true so it drains |

v1 ships without honoring them (minimal prompt: name/text/icon/color); the
frontmatter key is reserved so v1.1 adds behavior without a schema break.
Multi-entry chains (one prompt → several queue entries) are deferred.

## Library structure

- Group namespace: **`prompt-library`**; leaves: type `prompt`.
- Folders, nesting, create/rename/move/delete, drag — all from
  `entities-groups.md`. Every level of the menu offers "create folder" via
  the generic adapter capability; none of it is implemented here.

## Ribbon integration

Two ribbon additions in `TerminalBottomRibbon`, side by side:

```
[ ... Context  Git  Prompts  Files  Dir ]   [ Queue ]  [ Prompt Library ]
                    ^transcript prompts        ^side-tab    ^popover menu
```

- **Queue** becomes a visible ribbon tab (today it is URL-only). Pairing it
  with the library makes the destination of "add to queue" visible.
- **Prompt Library** (distinct name + icon — must not be confused with the
  existing transcript "Prompts" tab) opens a `BrowseableMenu` popover:

```
click "Prompt Library"
  -> BrowseableMenu( groupRoot({
        namespace: 'prompt-library',
        leafTypes: ['prompt'],
        leafToBrowseable: prompt -> {label: name, icon/color, pointer: editor}
        onSelectLeaf: prompt -> sdk.enqueueFromPrompt(process, prompt)
        capabilities: {createFolder: true, rename: true, delete: true, move: true}
     }))
```

### prompt → queue flow

```
click prompt leaf
  -> SDK enqueueFromPrompt(process, prompt)
       = process.enqueue(prompt.text, source='library')      (+ flags, v1.1)
  -> existing backend queue path: file write -> notify -> drain when ready
  -> queue log shows source='library'
```

No new queue machinery: the library is purely a producer for the existing
queue actions; injection/readiness stay exactly as specified in
`prompt_queue.md`.

### Leaf affordances

- click = enqueue (picker semantics via the adapter's `onSelectLeaf`).
- toolbar: **Open in editor** (real navigation, the markdown editor via the
  asset/editor pointer grammar) · **Enqueue** (explicit icon, same as click).
- folder toolbar: New folder · **New prompt** (quick-create dialog: name +
  text; icon/color via "open in editor" afterwards).

## Layer borders

| Layer | This feature's content |
|---|---|
| backend | `prompt` entity type + (v1.1) enqueue-flag honoring in the existing enqueue action. Nothing else — folders and queue already exist below. |
| ts_sdk | `Prompt` entity; `enqueueFromPrompt(process, prompt)`; quick-create wrapper. |
| hooks | none beyond the generic `useGroupTreeRefresh`. |
| tsx | ribbon button + popover composition; prompt leaf rendering. Zero logic. |

## Testing

- pytest unit: prompt record round-trip (frontmatter parse, optional fields),
  enqueue-from-prompt writes the queue file with `source='library'`.
- vitest source-contract: ribbon/menu composition is zero-logic (all calls go
  through SDK; no direct fetch/inject), extending the queue contract test.
- integration (DEEP_TESTING): library prompt → enqueue → drain → worker
  processes it (same harness as `test_prompt_queue_integration.py`).

## Deferred

Enqueue flags execution (v1.1), prompt chains, hub sharing of libraries,
usage stats / most-recently-used surfacing, prompt variables/templating.
