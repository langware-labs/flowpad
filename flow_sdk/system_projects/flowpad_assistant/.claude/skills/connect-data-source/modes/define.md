# Mode: define — the items get an output shape, a dataset and gold labels

> **Ground rules (inline by design):**
> **1. Evidence, never events.** A 200 is not proof; `poll_now` only marks a
> source due, so "I polled" is never "items landed". A dataset counts only what
> the folder holds — read `snapshot` back.
> **2. Read before you poke** — `poll_now` clears `health`, `error_code` and
> `error_detail` together.
> **3. Never widen a wait, a timeout, or a retry to make something pass.**
> **4. Never destroy the user's data to fix a symptom.**
> **5. The SHAPE is the user's decision** — propose, never decide alone.

The source is connected and streaming (`modes/connect.md` passed its gates).
Now the person says what they want *out of each item*. This mode turns that
into a dataset bound to the source — rows are the item envelope
(`ingest.source_item`), the output is the shape they chose — with at least one
labelled example, so the rows are ready for inference, annotation and training.

`DC` below means `python3 <this skill>/scripts/dataset_ctl.py`.

## Gate 1 — sample

`DC sample <source> --limit 5`. Show at least three items **as they are** —
name, body (trimmed), author, date — before asking anything. The question is
asked over real rows, never over the provider's description.

**Passes when** ≥3 items have been shown, or the source is `empty_but_healthy`
and you said so and stopped.

## Gate 2 — shape

Ask one question: *"What do you want to know about each of these?"* Then
propose **two or three** output shapes drawn from the sample, e.g.

- `{"sentiment": "string"}` — one label per item
- `{"topic": "string", "summary": "string"}` — a label and a one-liner
- `{"relevant": "bool", "reason": "string"}` — a gate with a why

Kinds are `string` `int` `float` `bool`, a list is `["string"]`, and a nested
object is another `{...}`. The person picks or edits one; you write what they
chose, verbatim. Do not add fields they did not ask for.

**Passes when** the person confirmed one shape.

## Gate 3 — dataset

`DC create '{"project_id": "<project>", "name": "<short name>", "source": "<source>", "output": {<shape>}}'`.
`<project>` is the project this session runs in (`flow context` names it) — a
source is global, the dataset is the person's, so it lands in THEIR project.
Read `dropped`: a non-empty list means a field did **not** apply — fix and
re-create; never report success over it. `spec` in the reply is the read-back;
it must show `input: "ingest.source_item"` and the chosen output.

**Passes when** `dropped` is empty and `spec` matches what the person chose.

## Gate 4 — example

1. `DC promote <dataset> <item id> [<item id> …]` for the items shown in gate 1.
2. Ask the person for the gold answer of ONE item, in the shape — or, if they
   said "you fill it", label it and say that you did.
3. `DC annotate <dataset> <example id> '{<gold>}'`. A `schema` in the error
   means the label does not fit the shape — show the person the schema, do not
   change the shape silently.
4. `DC snapshot <dataset>` — `num_examples ≥ 1` and `num_annotated ≥ 1` is the
   evidence. Report both numbers.

**Passes when** the snapshot shows ≥1 example and ≥1 label.

## Gate 5 — view

`flow show view "assets/editor/app/typeid/data_source_spec-<spec id>?app=spec&source=<source id>"`
— the source's editor: its config, the items, and the dataset pane where the
person keeps labelling. `<spec id>` is the `data_source_spec` whose `name`
equals the source's `provider` (`SC specs`). Exit `0` means recorded, not seen.
Close by naming the dataset, its shape, and the counts.
