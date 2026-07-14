---
id: c8fc79a4-af90-5bf1-af36-c0fe8f779d04
title: Group Tasks
---

# Group Tasks

A **group task** is one task, instantiated for every member of a contacts
group. You keep a single overview task; each member gets their own
**member task** to work and track independently.

## Example

Dana manages a five-person platform team. Before the quarterly compliance
deadline, everyone must finish the same security-training checklist. Instead
of creating five copies by hand, Dana opens the task
"Complete security training checklist", clicks **Owner → Group**, and picks
the *Platform Team* contacts group.

Flowpad then:

- turns Dana's task into the **group task** (the overview),
- creates one **member task** per teammate, assigned to them,
- invites each teammate: they get **editor** access to their own member task
  and **guest** (read-only) access to the group task.

Ravid marks his member task *Done* on Tuesday; Noa is still *In progress*.
Dana expands the group task in her task list and sees each member's status at
a glance — without anyone editing anyone else's copy.

## How it stays consistent

- The group task is the **single source of truth**: title, description, due
  date and priority always come from it. A member task owns exactly one
  thing: its **status** (plus the submission link it reports).
- The task's **plan stays with the owner** — it is not shared to members.
  Members see the group task's description.
- Members see the group task read-only, and only their **own** member task —
  never each other's.

## Tracking progress

Expand the group task in the task list to see every member task and its
status. **Analyze Status** on the group task goes further: it checks each
member's submission (for example, the repository link they turned in) against
the task's plan and writes a per-member summary report for the owner.
