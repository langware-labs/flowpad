---
name: translator
description: Translate a markdown document into another language. Use this
  whenever asked to "translate <doc> to language <lang> and save it to <path>",
  to produce a translated copy of a document, or to localize a markdown file
  into a target language. The prompt names the source file, the target language
  code, and the exact output path; this skill translates the content faithfully
  and writes ONLY that output file.
---

# translator — document translation

**Act now. This is one deterministic file operation: read the source, translate
it, write the target. Do not research, do not create entities, do not touch any
file other than the single output path you were given.**

The launching prompt gives you three things:

- **source** — the path (or asset ref) of the markdown document to translate.
- **language** — the BCP-47-ish target code (`es`, `he`, `fr-CA`, `zh-Hans`, …).
- **output path** — the exact file to write (a `translations/<lang>.md` file
  under the asset's record-data folder). It already exists as an empty
  placeholder; you **overwrite** it.

## Steps

1. **Read the source** document at the given path.
2. **Translate the prose into the target language**, faithfully and naturally —
   a fluent native reader should not be able to tell it was machine-produced.
   Preserve meaning, tone, and register; do not summarize, add, or drop content.
3. **Preserve structure exactly.** Keep every markdown construct byte-for-byte
   where it is not natural-language prose:
   - Heading levels, list nesting, tables, block quotes, and horizontal rules.
   - **Code blocks and inline code — do NOT translate.** Leave code, commands,
     identifiers, and file paths verbatim. You may translate a code block's
     *surrounding* prose and trailing comments only if a human reader would
     expect it.
   - **Links and images** — keep URLs/paths unchanged; translate visible link
     text and alt text.
   - Keep any HTML, math (`$…$`), and front-matter *keys* unchanged; translate
     front-matter *values* only when they are human-facing prose (e.g. `title`).
4. **Do not add a front-matter `id:`.** The output file is a data blob, not an
   entity — never write an `id:` field. If the source has one, drop it in the
   translation.
5. **Write the translation to the exact output path** given (overwriting the
   placeholder). Write nothing else — no new files, no reindex, no changes to
   the source.

## Right-to-left languages

For `he`, `ar`, `fa`, `ur` and other RTL targets, just write natural RTL text;
the UI sets text direction from the language code. Do not inject `dir=` markup.

## Done

When the output file is written, stop. The UI refreshes the translated document
automatically when this run completes.
