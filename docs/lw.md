---
id: 0c718911-f71b-4267-9109-c94feb163507
title: lw (langware) — statement docs
tags:
- lw
- lw.model
- lw.format
- lw.method
description: A project's langware is its statement docs — statements (architecture) and requirements
  (implementation) in fenced blocks, named and linked by tag into a dependency tree. The model, the
  format, the flow tag commands and the langit skill that writes them.
---
# lw (langware) — statement docs

A project's **lw** is its collection of statement docs and blocks, organised into a dependency tree
by tags, the way software packages are. The code is `flow_sdk/lw/`, the shapes are
`flow_sdk/schema/data_spec/lw_spec.py`, the commands are part of `flow tag`, and the `langit` skill is how a
design is recorded into it one statement at a time.

## The model

These are the owner's statements, in the owner's words (spelling fixed).

```statements
tag: lw.model
statements:
  - text: Langware is a collection of statement docs and blocks, organised into a tree by tag dependencies; think of it like software packages.
    basis: stated
  - text: A package is a project that exposes assets; its langware may be among them.
    basis: stated
  - text: Packages come with a different namespace ontology, the tag prefix --<package>--.
    basis: stated
  - text: Our root is --flow--; a namespace is not put everywhere, it is required only when another project's tags are used.
    basis: stated
  - text: Statement docs are plain docs, allowed to live anywhere in the project's docs.
    basis: stated
  - text: There is a single statement methodology and format across the Flow SDK.
    basis: stated
    issues:
      - In docs/breadcrumbs/ only the Invariants are statements; Expected behavior, Internals and Failure modes are prose.
      - docs/breadcrumbs/xml_entity_decode.md is not converted, its header is corrupted.
  - text: A breadcrumb references tags, blocks and docs; it is a separate linking mechanism from code to lw.
    basis: stated
    about:
      - flow_sdk/system_projects/flowpad_assistant/.claude/skills/tagit/scripts/insert_breadcrumb.py
```

```statements
tag: lw.format
depends_on:
  - lw.model
statements:
  - text: A statement is architecture; a requirement is implementation.
    basis: stated
  - text: A statement has no id.
    basis: stated
  - text: Statements live in a block as a list, and a single doc may contain several.
    basis: stated
  - text: A block and a doc have a tag, and they also have dependency tags.
    basis: stated
  - text: Statements do not have requirements; requirements are another list of things, with statements as their dependencies.
    basis: stated
  - text: Pass means no violation of the statement; v1 does not handle verification.
    basis: stated
  - text: v1 does not have versions.
    basis: stated
  - text: A statement may contain file references.
    basis: stated
    about:
      - flow_sdk/schema/data_spec/lw_spec.py
```

```statements
tag: lw.method
depends_on:
  - lw.format
statements:
  - text: Every statement is remembered and validated against the present.
    basis: stated
  - text: Every statement is crossed with past statements for conflicts or issues.
    basis: stated
  - text: Every statement updates the parts not yet discussed.
    basis: stated
  - text: A statement that contradicts the past is a required change and is considered true for the rest of the discussion.
    basis: stated
  - text: Only the owner's statements are recorded, and feedback on a statement is concise.
    basis: stated
```

## The format

The doc's header carries the doc's own tag and the tags it depends on:

```yaml
---
title: Unified machine access
tag: machine_access
depends_on:
  - access_keys
---
```

Each `statements` block carries its own tag, the tags it depends on, and a list of statements. A
statement has no id and no requirements.

````
```statements
tag: machine_access.remote_control
depends_on:
  - machine_access.connected_machine
  - machine_access.privileged_access
statements:
  - text: Remote control is flow connect with a node created locked.
    basis: stated        # stated | proven
    issues:              # checked against today; no issues = pass
      - Remote control uses only the first half of flow connect.
      - No node carries a "locked" setting.
    about:
      - flow_sdk/core/compute/hub_node.py:46
```
````

Requirements are a separate list. A `requirements` block names the statements it implements as its
dependencies:

````
```requirements
tag: machine_access.remote_control.build
depends_on:
  - machine_access.remote_control
requirements:
  - text: The node's creation config says "locked", and the worker enforces it.
```
````

A `test_debug` block: tagit's own fields (`sites`, `proven`) around the shared ones (`tag`,
`depends_on`, `statements`).

````
```test_debug
tag: breadcrumb.test.agent_activity_readout.rules
depends_on:
  - breadcrumb.test.live_frame_identity.rules
sites:
  - rel_path: ui/tests/unit/chat-activity-readout.test.tsx
    line: 49
    note: FAILING? read this tag's rules before editing
proven: 2026-08-13 · FLOWPAD-1980
statements:
  - text: The activity line takes the process and nothing else.
    about: ["ui/src/components/chat/ChatActivityReadout.tsx"]
```
````

| Field | In | Meaning |
|---|---|---|
| `tag` | every block | The block's name: a tag in the one grammar ([tags.md](tags.md)), unique in the project. |
| `depends_on` | every block | Tags this block builds on: a block's or a doc's. Another project's tag carries its prefix, `--<package>--.<tag>`. Optional. |
| `statements` | `statements`, `test_debug` | A list. Each has `text`; optional `basis` (`stated` by the owner, `proven` by a test or a root cause), `issues`, `about`. |
| `issues` | a statement | What in today's code violates the statement, one sentence each. None means it passes. |
| `about` | a statement | The files it is about: `path` or `path:line`, from the project root. |
| `requirements` | `requirements` | A list. Each has `text` only. The block depends on the statements it implements. |
| `sites` | `test_debug` | The tests the rules are bound to: `rel_path`, optional `line` and `note`. |
| `proven` | `test_debug` | When the rules were proven, and the ticket when there is one. |

A doc's own tag is its header's `tag`, and what the doc depends on is its header's `depends_on`.
The header's `tags` list is every tag the tag index binds the doc to. Writing a
block lists the block's tag in the doc's `tags`, which is what binds the doc to that tag in the tag
index: `flow tag get <block tag>`, the tag graph and the `tag-context` skill find statement docs with
no index of their own.

A block is whatever a markdown reader sees as a code block whose language is `statements`,
`requirements` or `test_debug`: backticks or tildes, a fence of any length, indented up to three spaces (inside a
list item). A block shown inside another fence, as the example above is, is text and not a block.

## The command

These `flow tag` subcommands run in-process on the project that contains the current directory; no server is needed.
They read the project's `docs` folder (`--root <folder>` to point elsewhere).

```bash
flow tag blocks              # every doc that holds blocks, with its tags
flow tag check             # validate every block and every dependency
flow tag tree <tag>        # the dependency tree under a tag
flow tag show <tag>        # a block (or a doc's blocks), what it depends on, what depends on it
flow tag put --doc <path> --kind statements --tag <tag> --json '{"statements": [{"text": "..."}]}'
flow tag drop --doc <path> --tag <tag>
```

`check` fails on: a body that is not valid YAML or does not match its schema (an unknown field, an
empty list, a statement with an id or requirements), a tag used twice, a dependency that names
nothing, a dependency cycle, and a `requirements` block that depends on no `statements` block.
`put` replaces one block by its tag, or adds it at the end of the doc, and leaves the rest of the doc
as it is, line ends and the block's indent included; a refused `put` writes nothing, and two writers
of one doc take turns. `drop` is refused while another block depends on the one being removed.
`tree` lists a shared dependency under each block that uses it, with its own dependencies only the
first time. Folders the indexer ignores (`node_modules`, dot folders, anything `.gitignore` names)
are not read.

A dependency on another project (`--acme--.orders.created`) is looked up in that project's lw. Where
that project lives is known to a running Flowpad; on the command line pass
`--package acme=<its folder>`.

`tests/unit/test_lw.py` runs the check on this repo's docs.

## Who writes it

- The **`langit`** skill records an owner's design one statement at a time: it writes the statement,
  lists what in today's code violates it, crosses it with the statements it depends on (a new
  statement that contradicts an earlier one wins), and keeps the requirements that follow.
- The **`tagit`** skill writes a proven root cause as a rules doc whose bound tests and invariants are one
  `test_debug` block. The breadcrumb it drops on the failing test is the separate link from code to that doc's tag.

## In the app

The editor draws each block as a card ([renderable-fences.md](renderable-fences.md)): the tag, the
tags it depends on, and a row per statement with `pass` or its issues and a chip per file. A
`test_debug` card shows its bound tests and when it was proven first. The Code tab shows the YAML.
Under the doc's title the editor shows the header's tag and what the doc depends on.
