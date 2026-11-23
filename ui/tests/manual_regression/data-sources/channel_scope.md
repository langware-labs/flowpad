---
id: 3b6a89ba-fd64-4d9c-a3bd-0ccd59c46689
---

# Where a new source is saved — Me or Project

precondition: an instance is up and signed in. No Google sign-in is needed (the Gmail
channel is added, never verified). The automation makes its own project in a temporary
git repository and removes it, with the sources it added, when it ends.

Automated (`channel_scope.md.ts`): every case ends on disk — the `data_source.json` a
click produced is looked for under the user scope and under the project's folder.

test 1: a message channel is saved for Me, though a project is open
- [browser] open the project, then the stream inbox; press + on the channels line; pick Gmail
- [browser] "Saved for" starts on Me; Project can be picked
- [browser] add it
- [api] the source has no project; its folder is under the user scope's `agentic-assets/data_source/`
- [api] the project's folder holds no source and `git status` sees none; the project's own source list does not have it
- [browser] it is on the stream inbox line (its attention chip); the project's home does not show it

test 2: picked for the Project, it is saved in the project folder
- [browser] same form, pick Project, add
- [api] the source carries the project; its folder is under the project's `agentic-assets/data_source/`; `git status` sees it
- [browser] the project's home shows it under Message channels

test 3: a data source starts on Project; Me keeps it out
- [browser] Data sources → Add → RSS: "Saved for" starts on Project; add → saved in the project folder
- [browser] the same with Me picked → saved under the user scope, not in the project folder
- [browser] the source's Settings tab says "Saved for: Me"
