---
id: 5c0e4b8a-6a1d-4f3e-9b72-3d8f1a2c7e45
name: langit
description: >-
  Records an owner's design as checked statements, one at a time. For each
  statement the owner gives: write it into a `statements` block in the repo
  docs, check it against the code today (pass or a list of issues), cross-check
  it with the statements it depends on, and update the `requirements` that
  follow. Statements are the architecture, requirements the implementation.
  `langit check` validates every block, `langit show <tag>` reads one with what
  it depends on and what depends on it. Ends by bringing the docs index up to date. Triggers on "statement: ...", "S1: ...",
  "let's close the principles one by one", "record this as a statement",
  "langit", or "check the statements".
tags: ''
eval: 'false'
version: 1
---

# Langit — an owner's statements, checked one at a time

The owner states the design one sentence at a time. You record each statement,
check it, and keep everything that depends on it true. You never add a statement
of your own.

The project's statement docs are its **lw** (langware): a collection organised into a dependency
tree by tags, like software packages. Everything is read and written with the statement commands of `flow tag`, run from
inside the project; it reads the project's `docs` folder (`--root <folder>` to point elsewhere)
and needs no running Flowpad.

## The model

| Thing | What it is | Fields |
|---|---|---|
| **Statement** | Architecture: what is true by design | `text`, `basis` (`stated` or `proven`), `issues` (optional), `about` (optional) |
| **Requirement** | Implementation: what must be built | `text` |
| **Block** | A fenced YAML `statements` block | `tag`, `depends_on` (tags), `statements`, `requirements` (optional) |
| **Doc** | A plain doc anywhere in the project's docs, holding several blocks | frontmatter `tags`, `depends_on` (optional) |

- A statement has **no id** and **no requirements**. A dependency names a **tag**: a block's or a doc's.
- A statement with no `issues` **passes**: nothing in the code today violates it. Each issue is one sentence saying what violates it.
- `about` lists the files a statement is about: `"flow_sdk/utils/machine_id.py"` or `"flow_sdk/utils/machine_id.py:29"`, relative to the project root.
- A tag of **another project** is written with its namespace: `--<package>--.<tag>`. Tags of this project are written bare.
- Requirements are the `requirements` list of the statements block they implement. There is no requirements block.
- `basis: stated` = the owner said it. `basis: proven` = a test or a proven root cause shows it.

````
```statements
tag: machine_access.remote_control
depends_on:
  - machine_access.privileged_access
statements:
  - text: Remote control is flow connect with a node created locked.
    basis: stated
    issues:
      - No node carries a "locked" setting.
requirements:
  - text: The node's creation config says "locked", and the worker enforces it.
```
````

## Modes

| Invocation | What it does |
|---|---|
| `langit <topic>`, or the owner gives a statement | Start or continue a statements doc (below) |
| `langit check` | `flow tag check`; report its output |
| `langit show <tag>` | `flow tag show <tag>`: the block (or, for a doc tag, every block of the doc), then the blocks it depends on, then the blocks that depend on it |
| `langit tree <tag>` | `flow tag tree <tag>`: the dependency tree under a tag; for a doc tag, the doc's blocks and theirs |
| `langit list` | `flow tag blocks`: every doc that holds blocks, with its tags |

## Starting

1. **Find the doc.** Use the doc the owner names. Otherwise run `flow tag blocks` to see whether the topic already has a doc; if not, create one where the project keeps the docs of that subject (any folder under its docs), named `<slug>.md` (slug: up to 3 words, snake_case, the topic; the doc tag is the slug):

   ```markdown
   ---
   title: <Topic>
   tags:
   - <doc tag, e.g. machine_access>
   description: <one sentence: what these statements govern>
   ---
   # <Topic>

   > Statements by the owner. Do not edit without the owner's approval.
   ```

   Do not write an `id:`; indexing adds it. When the topic builds on another doc or block, add a frontmatter list `depends_on:` with those tags; otherwise leave the key out. After writing the doc, create its tag once: `flow tag create <doc tag> --title "<Topic>" --description "<one sentence>"` (running it again for an existing tag is harmless). Block tags need no creating.
2. **Read what is already stated** (skip for a doc you just created): `flow tag show <doc tag>` prints every block of the doc and every block they depend on.

## For every statement the owner gives

Do all four steps before answering, one statement at a time. Steps 1 to 3 are thinking and reading; nothing is written until step 4, so each block is written once.

1. **Place it.** Keep the owner's meaning and words; fix only spelling and grammar. Choose its block: the existing block that is about the same subject, or a new block `<doc tag>.<subject>` when the statement brings a new subject. Set `depends_on` to the blocks whose statements it builds on.
2. **Check it against today.** Read the code the statement is about. The statement passes, or it gets `issues`: one sentence each, naming the file and what it does (`flow_sdk/utils/machine_id.py:29 never reads ~/.flow/machine_id`). Record only what the code shows, not what you infer from it. A violation you found in another repository is an issue too: name the repository in the sentence; `about` is for this project only. When the code does part of what the statement says, the missing part is the issue. If you could not check a statement, or a part of it (the code is not in this project), say which part under "Today" and record issues only for what you saw.
3. **Cross-check it with the past.** Run `flow tag show <block tag>` (for a new block, show the blocks it will depend on) and compare the statement with every statement printed.
   - **It contradicts an earlier statement:** the new statement wins. Rewrite the earlier one, or leave it out of its block when nothing of it remains, and say which one changed. The new statement is true for the rest of the discussion; do not argue it again.
   - **You replaced a statement that other blocks depend on:** their statements were checked under the old meaning. Check each of them against the code again and update its `issues`; do not touch its text.
   - **It does not contradict a statement but takes away its reason** (for example a block built on the statement you just replaced): leave that statement's text alone. Name it in the reply under "To decide".
4. **Write.** Put the statement's block, any earlier block you changed, and the requirements:
   - Every issue means something must be built. Write it as a requirement, one sentence saying what must change and where, in the `requirements` list of this statements block.
   - Do not repeat a requirement that a block this one depends on already states; one requirement, in the block of the statement it mostly serves.
   - Remove requirements the new statement makes unnecessary.

Write each block with `flow tag put`, never by editing the YAML by hand. It replaces the block that has the tag, or adds it at the end of the doc, lists the block's tag in the doc's frontmatter `tags` (which is what makes `flow tag get <tag>` find the doc), and leaves the body of the doc untouched (the header may be re-wrapped, and Flowpad adds an `id:` to a new doc on its own):

```bash
flow tag put --doc <path to the doc> \
  --kind statements --tag <block tag> \
  --json '{"depends_on": ["<tag>"], "statements": [{"text": "…", "basis": "stated", "issues": ["…"]}], "requirements": [{"text": "…"}]}'
```

`--json` carries the **whole block** (every statement in it, old and new), not only the new one; a statement or a requirement you leave out is gone. `put` checks the doc before it writes: a refused put prints the reason and writes nothing; fix the block and run it again. Write a block before the blocks that depend on it.

To delete a whole block: `flow tag drop --doc <path> --tag <block tag>`. It is refused while another block depends on it; change or remove that one first.

**Then answer, in a few lines:**

- **Recorded:** the statement and its block tag.
- **Today:** pass, or the issues.
- **Past:** agrees, or which earlier statement changed and how.
- **Follows:** the requirements added or removed.
- **To decide:** only when step 3 found a statement whose reason is gone; one line each.
- **Not done:** only when a step could not run (a command that failed or is not available).

## Rules

- **Only the owner's statements go in a `statements` block.** Your findings are issues and requirements; your ideas go in the reply, never in the doc.
- **A statement is not a question.** Do not ask the owner to justify it. Ask only when you cannot tell what it means.
- **Keep the reply short.** No recap of earlier statements, no restating the method.
- **Prose around the blocks is the owner's.** Do not rewrite it.
- **Nothing is implemented here.** Requirements are a list, not a go-ahead.

## Closing

When the owner says the statements are closed, or the session's changes to the docs are done:

1. `flow tag check` must print `OK`. Fix every problem it lists.
2. Index every doc you added or changed, once, after all your changes: `flow record index <doc>`. This is what binds the doc to its tags, so `flow tag get <block tag>` finds it; confirm with one block tag.
3. When the project has a `docit` skill, run it:
   - docs were **edited**: `docit <the doc paths you changed>`;
   - a doc was **added**: also `docit index`. It reports whether the docs index is stale and writes nothing. Rebuilding the index (`docit index full`) costs model calls and touches other folders, so it is the owner's call: report that it is needed, do not run it unasked.
4. Report: the doc, the blocks and their tags, how many statements pass and how many have issues, the requirements list, every "To decide" item the owner has not answered, and what the docs step reported (or that it could not run).
