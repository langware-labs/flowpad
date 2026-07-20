---
id: 10622f1c-7677-42c0-a42d-bf53b572c8c2
title: Skill assets
---

# Skill assets

A **skill** is a folder of instructions an agent loads when a task matches it —
a packaged procedure for one kind of work: a deploy sequence, a review
checklist, a repo-specific workflow. Instead of re-explaining the steps every
time, you write them once and the agent follows them.

On disk a skill is a **folder containing a `SKILL.md` file**, not a single
document: `.claude/skills/<name>/SKILL.md`. The frontmatter carries the skill's
`name` and a `description` — the description is what an agent reads to decide
whether the skill applies, so it's the most load-bearing line in the file. The
body is the instructions themselves. Because a skill is a folder, it can also
hold reference files, scripts, or templates the instructions point at.

Creating one asks for a name and drops you straight into the editor with the
cursor under the headline, ready to write.

## Where it lives

A skill created with a project active belongs to that [[Flowpad project]]. With
no project active it goes to your home folder instead, where every project can
see it.

## Good to know

- **The description is the trigger.** An agent matches a task against the
  description, not the body. A vague one means the skill never fires; a
  specific one — naming the triggers and the deliverable — means it does.
- **A skill is just files.** You can edit it in any tool, commit it, and share
  it. Sharing one into a conversation works like any other asset, including
  [[Git sharing]] when it lives in a repository.
- **It's not automatic.** Writing a skill doesn't run it. An agent loads it
  when the work matches, or when you name it directly.

See also [[Sub agents]], which are the other way to package agent behavior.
