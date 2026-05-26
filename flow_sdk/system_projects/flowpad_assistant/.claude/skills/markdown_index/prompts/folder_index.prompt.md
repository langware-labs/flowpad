# Folder index assembly

Assemble the `index.md` for folder `{{FOLDER_NAME}}` using the template below.

Hard rules:
- Fill in placeholders verbatim. Do NOT invent new sections.
- **Self-Summary** ≤ 60 words. One paragraph that describes the *scope* of this
  folder (what it covers, not what it contains). The parent index will quote
  this verbatim — write it so it stands alone.
- **Files list**: one bullet per file: `- [<filename>](<filename>) — <summary>`.
  Use the per-file summary supplied below (do NOT re-summarise; copy verbatim
  except for trailing whitespace).
- **Subfolders list**: one bullet per child: `- [<name>/](<name>/index.md) — <child self-summary>`.
  Quote the child's Self-Summary verbatim (≤ 60 words already).
- Use the `INPUTS_HASH`, `ENTITY_ID`, `PARENT_REF`, `VAULT_ROOT`,
  `ISO_TIMESTAMP`, `PROCESS_REF`, `FILE_COUNT`, `SUBFOLDER_COUNT` values
  provided — do NOT recompute.

----- TEMPLATE -----
{{TEMPLATE}}
-------------------

----- FILE SUMMARIES (one per direct source file) -----
{{FILE_SUMMARIES}}
-------------------------------------------------------

----- CHILD SELF-SUMMARIES (one per subfolder with index.md) -----
{{CHILD_SELF_SUMMARIES}}
-----------------------------------------------------------------

Output the assembled `index.md` (frontmatter + body) and nothing else.
