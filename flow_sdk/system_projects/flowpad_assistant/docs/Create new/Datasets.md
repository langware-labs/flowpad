---
id: 8ff39a96-d1e5-4b87-a1b2-cb0ba1834875
title: Datasets
---

# Datasets

A **dataset** keeps rows of one **kind** — the kind is the name of a schema
your project defines (`gtm.persona`, `crm.lead`), and every row is a value of
that schema.

A dataset's rows live in a **data source**. Every project has the default
source **local**: the project's own file system, where the rows sit in the
dataset's `rows/` folder. Pick another data source (a Google Drive folder, a
bucket) and the rows are kept there instead, in the **folder** you name —
by default the dataset's name.

When the data source you picked is not set up yet, the rows are kept locally
until it is, and the dataset says so.

The **Data model** screen shows it all at once: the project's kinds, which
dataset keeps rows of each, and which data source hosts each dataset.
