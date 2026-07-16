---
id: 65756bdb-c804-420b-9c2c-34cd53b4f427
title: Task assets
---

# Task assets

A **task** is a tracked piece of work: a title, a description, a status, and
optionally a due date, a priority, and a plan. Creating one asks for a title
and opens it in the task editor.

Unlike most assets, a task is a **folder** rather than a single file. The
folder holds `task.md` — the frontmatter (title, status) plus the description —
and `spec.md`, a plain file holding the plan or issue content. Keeping the plan
in its own file is what lets a task travel intact: when a task is shared, the
whole folder goes, so the recipient gets something they can actually work.

## When to use one

Use a task when the work has a lifecycle you want to track separately from the
conversation or session that produced it — something with a status you'll come
back and change. For a one-off instruction to an agent, a
[[Prompt library|prompt]] is lighter.

## Assigning to a group

A task can be assigned to a whole contacts group, which gives every member
their own copy to work while you keep a single overview. See [[Group Tasks]]
for how that works and how progress is tracked.

## Good to know

- **The plan is yours.** When a task is shared, some fields are deliberately
  left behind — the ones that only mean something on your machine, like the
  local project it came from — so the recipient gets a task that runs on
  theirs. For group tasks, the plan stays with the owner too.
- **Status is the thing that changes.** Title, description, due date, and
  priority describe the work; status is what tracks it. In a group task, that
  split is enforced — a member task owns its status and nothing else.
