---
id: 4f1c1d0e-7c39-4b8e-9a51-5f0c2b7e3a10
---

test 1: The Files tree is a file manager — toolbar, right-click, keys, drag
- [setup] a temp project with docs/a.md, docs/b.md, notes/n.md
- [browser] open the Assets page scoped to that project, expand Files, docs, notes
- [browser] right-click docs/a.md — the menu lists Open, Cut, Copy, Duplicate, Rename, Delete, Copy path, Copy relative path, Reveal in Finder, Download
- [browser] right-click the docs folder — the menu also lists New file, New folder, Paste, Open in terminal, Upload files here…, Download as zip
- [browser] docs folder hover toolbar → New folder "archive" → it exists on disk and shows in the tree
- [browser] right-click docs/a.md → Copy; right-click notes → Paste → notes/a.md exists, docs/a.md still exists
- [browser] select notes/a.md, press F2, type "renamed.md", Enter → notes/renamed.md on disk, the row is renamed
- [browser] select docs/b.md, press ⌘D → docs/b copy.md on disk
- [browser] drag docs/b.md onto notes → it moves (notes/b.md exists, docs/b.md gone)
- [browser] drop an OS file "dropped.md" onto docs → docs/dropped.md on disk
- [browser] ⌘-click docs/a.md and docs/dropped.md, press Delete, confirm "Delete 2 items?" → both gone, selection cleared
