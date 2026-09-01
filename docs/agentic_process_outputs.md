---
id: e64bb933-a999-4554-9a70-befeee0c6165
---

# Agentic process outputs

What a run produces, how it is recorded, and how it reaches the screen.

## The problem this replaced

There was no "output" concept. Nine uncoordinated mechanisms produced them, four
incompatible representations stored them, and the only thing deciding "this is
an output" was a sentence of English in a prompt asset. The measurable result:
**214 process record directories on disk, 3 output files in total**, ~49 of them
empty skeletons a serializer created as a side effect of `model_dump()`.

Three ideas replace it: a **derivation layer** that turns transcript shape into
meaning, an **Artifact** that records what a run produced, and a **bus lane**
that keeps clients current.

---

## 1. The derivation layer

`flow_sdk/transcript_analyzer/derivation/`

A parser's job ends at *shape*: a vendor line becomes the closest physical entry
it can — a tool use, a shell command, a message. Everything above that is
*meaning*, and meaning is worker-agnostic.

Before the layer, each semantic kind was implemented once per parser, so a kind
existed only where somebody remembered it. That was not a decision, it was a
gap, and it was invisible — a missing chip looks exactly like a worker that did
not do the thing. Measured: claude produced 11 semantic kinds, codex 5, copilot
6. Codex emitted no `ShellCommandEntry` (its shell calls rendered as nameless
tool rows); copilot emitted no `ExitPlanModeEntry` (so the Open-Plan chip could
not exist there).

### How it works

```
register(worker: str | "*", kind: EntryKind, handler)
handler(entry) -> list[TranscriptEntry] | None
derive_entries(entries) -> list[TranscriptEntry]
```

* **Additive.** A generated entry is appended *beside* its source, never in
  place of it. The physical record of what the worker actually emitted stays
  auditable; a consumer wanting only meaning filters on `virtual`.
* **Recursive.** A generated entry is fed back into the worklist, so each layer
  stays one rule:

  ```
  ShellCommandEntry / ToolUseEntry   physical
    └─ FlowCommandEntry              virtual   (*, SHELL_COMMAND)
         └─ ArtifactEntry            virtual   (*, FLOW_COMMAND) when verb == "artifact"
  ```

* **Terminating.** A visited set of `(handler, entry.id)` plus a depth cap. This
  is not theoretical: `ExitPlanModeEntry` has no `EntryKind` of its own and
  inherits `TOOL_USE`, so a handler re-derived its own output until the cap
  stopped it with a diagnosable warning.
* **Idempotent.** `parse_delta` re-derives the whole retained list on every
  delta. Generated ids are deterministic (`{source.id}:{layer}`), so
  "already present" is an exact test — and a *partially* derived chain still
  grows its missing leaf.

### Two envelope fields

`virtual: bool` says an entry was generated; `derived_from: str | None` says
from what. The link is what makes the UI's suppression rule exact — hide any
entry that is the `derived_from` of another entry present in the same stream, so
only the leaf of a chain renders, with no per-kind special-casing.

Both ride `TranscriptEntry.to_dict`, which the layer reads *unbound* to rebuild
an envelope, so a new envelope field is carried through derivation for free. The
pairing is load-bearing: a key in `to_dict` with no matching `__init__` kwarg is
a `TypeError` on a parse path.

`is-virtual` is additionally stamped on `FlowData.attributes` by the three replay
wrappers, so a consumer can filter without reaching into `process_entry` — a
physical entry and its refinement share a `tool_use_id`, so anything counting
calls needs to tell them apart.

### Ids: suffixed vs inherited

The **entry id** is suffixed per layer (`e1`, `e1:flow_command`, `e1:artifact`) —
uniqueness is what the visited set relies on.

The **`tool_use_id` is inherited unchanged**. It is the pairing key the vendor's
tool result carries; a refinement that suffixed it would pair with nothing and
render as permanently in-flight, because an unpaired `TOOL_CALL` still becomes a
pair with `result: null` rather than falling through to the non-tool bucket.
The duplicate is resolved by the consumer dropping the physical twin.

### File layout

```
derivation/
  __init__.py        public surface: register, derive_entries
  registry.py        (worker, kind) -> handlers; worklist, visited set, depth cap
  virtual.py         minting: envelope copy, suffixed id, provenance
  handlers/
    tool_semantics.py  a generic tool-use -> a semantic entry
    tool_maps.py       per-vendor {tool name -> semantic key} + argument aliases
    flow_command.py    (*, SHELL_COMMAND) -> FlowCommandEntry
    artifact.py        (*, FLOW_COMMAND)  -> ArtifactEntry
```

The vendor-specific part is a **table**, not code: adding a tool is a row,
adding a semantic kind is one constructor shared by every worker, and a gap
shows up as a missing row rather than as silence.

---

## 2. The Artifact

An **Artifact** is a *reference to a generated asset* plus the provenance edge
back to the run that made it. It is not a container: the bytes belong to the
asset it points at, and clicking an artifact opens that asset, never the
artifact.

| Field | Meaning |
|---|---|
| `asset_ref` | path of the asset it references, when it is a file |
| `target_type_id` | TypeId of the entity it references, when it is a row |
| `generated_by` | TypeId of the producing run (`agentic_process-<uuid>`) |
| `kind` | open dot-path ontology (`content.file`, `application.web`, …) |
| `owns_asset_ref = False` | it references a path; it never *owns* one |

### Two ways to address a deliverable

`asset_ref` assumes every deliverable is a file. Not all are. A message an agent
**sent**, a task it opened, a record it created — these are rows with no path,
and addressing one by `asset_ref` yields the empty string, i.e. an artifact
pointing at nothing, indistinguishable from a bug.

`target_type_id` is the identity form, and it is the primary one for anything
the agent produced *in the system* rather than *on disk*. Both may be set: a
file-backed entity has a path and an identity, and the identity is the exact
address where the path still has to be resolved back through
`Entity.get_by_asset_ref`. The bus lane carries `target_type_id` for the same
reason it carries `asset_ref` — an event a subscriber cannot resolve is noise.

### `kind` comes from the entity, not from the address

`register-artifact` used to infer a binary — `application.web` for a webapp
target, `content.file` for everything else. That erases what the referenced
entity already knows: a `source_item` **is** `content.message.email`, and no
amount of looking at its (nonexistent) path recovers that.

So an entity that declares its own ontology `kind` is the authority, and the
binary is the fallback for targets that declare nothing. This is what lets a
consumer tell *"this run sent a message"* from *"this run wrote a file"* off the
`artifact.created` event alone, with no follow-up fetch. A malformed kind falls
back rather than failing the registration — losing a label is not worth losing
the record of a deliverable.

**`owns_asset_ref` is not a detail.** `Entity.get_by_asset_ref` enrols every type
declaring an `asset_ref` and returns the first hit in registry order, and its
contract says a path maps to exactly one entity. An artifact naturally carries
the same path as the asset it references, so without the flag it competes for
ownership and wins or loses by iteration order — verified: a `spec` (registered
before `artifact`) resolved correctly while a `dataset` (registered after)
resolved to the artifact. The same rule has a second consumer:
`wiki.service._implicit_project_assets` enrols anything with both `project_id`
and `asset_ref`, so an unguarded artifact would become a competing candidate for
its own document's `[[wiki link]]`.

### Registration is explicit

`flow artifact entity|file|webapp` (exit codes `0`/`2`/`4`/`5`, matching
`flow show`) posts to `register-artifact`, which resolves the address through the
shared `resolve_display_target` policy, stamps `generated_by` **from the URL
scope — never from the body**, and presents it unless `--no-show`.

Not every file an agent writes is an artifact. Nothing is inferred from writes
and nothing is swept off disk: an artifact is a distinct deliverable — an app, a
plan, a document, a skill, **a message it sent** — that the user asked for or
that is the direct product of what they asked for.

The counter-example worth keeping in mind is the **run receipt**: the small JSON
a worker leaves in `execution/output/` so its caller can read a structured
result (`ingest/drivers/agent.py`'s `sent.json`). That is a *return value*, not
a deliverable — nobody asked for it, and registering it would put a file nobody
wants to open in the run's output list. The email send registers the
`source_item` it created, and leaves its receipt alone. The platform has no
named contract for run return values; the receipt convention is local to its
driver.

`flow show` remains the display-only verb. The two are distinct contracts:
`show` changes display focus, `artifact` records durable provenance and may also
present.

---

## 3. Reaching the client

Three channels, none redundant:

| Channel | Answers | Why nothing else can |
|---|---|---|
| `proc.artifacts` (property, REST once on load) | *what exists* | events have no replay; reconstructing from the stream means replaying all history |
| `artifact.*` bus lane | *what changed since load* | a cheap ordered delta carrying the producer |
| `ArtifactEntry` in the stream | *what happened, in order* | inline with the calls that produced it, and replay-safe |

The first two maintain a **set**; the third is an **append-only log**. They
reconcile on artifact id.

**The lane** — `flow_sdk/builtin/artifact_on_tag.py` emits
`artifact.created|updated|deleted` with `target_of("artifact", id)` (the bus's
colon grammar, never the dash TypeId), lean `data` (identity and pointers, never
the row), and `ctx.scope` carrying the producer. Emitted from the artifact's own
operations rather than the generic DataOp funnel, because that funnel passes
`data=None` on delete — precisely when the producer is the field that is no
longer readable.

**Ordering hazard.** The client must **subscribe before fetching** and merge the
snapshot by id. Fetch-then-subscribe silently drops any event landing in the gap,
leaving the array permanently short a row with no error.

**Replay needs no special mechanism.** The artifact chip is a *derived* entry, and
derivation runs on every refold, so a reload rebuilds the same chip from the same
JSONL. The identity the transcript cannot hold — the minted artifact id — lives in
the artifacts list, joined by address. A server-synthesized frame would have
existed only in the live stream and vanished on refresh.

---

## Related

* [display-capabilities.md](display-capabilities.md) — how a target becomes a rendered view
* [tags.md](tags.md), [flow-events.md](flow-events.md) — the bus envelope and the forward allowlist
* [data-management/transcript-indexing.md](data-management/transcript-indexing.md) — the side-effect pass over parsed entries

