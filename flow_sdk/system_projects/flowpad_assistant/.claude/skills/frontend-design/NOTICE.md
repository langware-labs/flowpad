# Third-party skill — attribution and modifications

`SKILL.md` in this folder is **not ours**. It is vendored from Anthropic's public
skills repository and redistributed under the Apache License 2.0, whose complete
terms are in `LICENSE.txt` beside it.

* **Upstream:** https://github.com/anthropics/skills — `skills/frontend-design/`
* **Copyright:** Anthropic PBC
* **License:** Apache-2.0 (see `LICENSE.txt`)
* **Vendored:** 2026-08-30

## Modifications

Apache-2.0 §4(b) asks that modified files carry a prominent notice. `SKILL.md` is
vendored **verbatim** with one exception, which is mechanical rather than editorial:

* **The YAML frontmatter is rewritten by the asset indexer.** Flowpad identifies a
  skill by the id in its `SKILL.md` frontmatter (`folder_md_identity` in
  `flow_sdk/schema/type_info/skill_type_info.py`), so on first index it adds an
  `id:` key and re-emits the block, which also re-wraps the existing
  `description:` across lines. **Not one word of the document body is changed**,
  and the description's text is preserved exactly.

Nothing else is edited. In particular, Flowpad's own routing lives in
`html-builder/SKILL.md` and `.claude/agents/vibe.md` rather than in this file, so
the upstream text stays clean and re-vendoring is a straight overwrite.

## Why it is here

This skill carries **taste** — palette, typography, motion, restraint. It states
nothing about build tooling, file layout or shipping, which is deliberate. The
complementary half is `html-builder`, which owns the craft of building a static
page with no build step. The two are meant to be used together.
