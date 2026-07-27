---
id: 6de42829-8a14-4edd-8ddb-a9fc8327a00a
title: Shared context folders
---

# Shared context folders

A **shared context folder** is a [[Context folders|context folder]] that belongs
to the project rather than to your machine. Same idea as a
[[Private context folders|private]] one — documents, skills, agents, reference
material — except everyone the project is shared with gets it too.

## Flowpad shares the location, not the folder

This is the part worth understanding: **Flowpad never copies the folder.** What
travels is the folder's **origin** — a pointer to where its contents actually
live, which the recipient then fetches from that same place. Your local path
never goes on the wire; it would leak your disk layout and mean nothing on
someone else's machine anyway.

So a shared folder needs a location other people can reach. **Today that means a
Git repository** — a folder inside a repo with an `origin` remote. The origin
model is deliberately backend-agnostic (the check is "can this location travel?",
not "is this Git?"), so other kinds of location can be added later; Git is the
only one implemented now. Try to share a plain local folder and Flowpad says so,
and offers to add it as private instead. See [[Git context folders]].

Because only the location travels, a shared folder is only as current as what
you've pushed. Committing and pushing is what actually shares the work — see
[[Git sharing]], which applies the same principle to single assets.

## How teammates get it

When someone opens a project carrying a shared folder, their Flowpad resolves
the origin and fetches a copy onto their machine.

To tell a teammate about a folder directly, use **Push** on the folder and tick
**Notify**: they get a chip in the conversation that sets the folder up in one
click. Notify is off by default, and plain project sharing sends no
announcement — the folder simply arrives with the project.
