---
id: 145bc443-e7dc-4971-ae46-8844c5721b4a
title: Markdown documents
---

# Markdown documents

A **markdown document** is a plain `.md` file — notes, a design doc, a README,
anything you'd write prose in. It's the least opinionated thing you can create:
no frontmatter you have to fill in, no structure imposed. Creating one asks for
a name and opens it in the markdown editor.

The document's **title is its filename**, not a frontmatter field. Renaming the
file renames the document.

## Where it lives

A document created with a project active lands in the [[Flowpad project]]'s
`docs/` folder. With no project active it goes to your home folder instead.

## Linking

Documents link to each other with **wiki links** — `[[Page name]]`, or
`[[Page name|display text]]` when you want different link text. A link to a
page that doesn't exist yet is fine; it marks the page as worth writing. The
editor shows backlinks, so you can see what points at the document you're in.
You can also link to a heading within a page with `[[Page name#Heading]]`.

The page you're reading now is an ordinary markdown document, and so is every
other page in this wiki.

## Good to know

- **Flowpad won't overwrite your edits.** Unlike most asset types, a markdown
  document is only written by Flowpad when the file doesn't exist yet. After
  that it's yours — edit it here, in your editor, or from an agent session, and
  nothing clobbers it.
- **It's a real file.** Commit it, move it, open it in any other tool. Sharing
  one into a conversation works like any other asset, including [[Git sharing]]
  when it lives in a repository.
