---
id: 5189720c-c4c4-46ff-aceb-c0a72d98585b
title: Help desks
---

# Help desks

A **help desk** is somebody else's support desk, published as a Git repository
and adopted by your project. Adding one gives you their guides, their support
agent, and a route for your questions to reach them — without leaving Flowpad.

You don't create a help desk here. A desk is authored in its publisher's
repository; the **Add help desk** tile points your project at one.

## Adding one

Paste the desk's repository URL. If the desk lives on a branch of its own —
which is common, because a vendor often publishes the desk separately from
their main code — click **Choose branch** and pick it. Getting the branch right
matters: the wrong branch is a different desk, or no desk at all.

If you connect GitHub you can also browse your own repositories instead of
pasting, but a public desk needs no connection.

The desk is added as a [[Dependencies|dependency]] — required by default, so
everyone who gets the project gets the desk too. Choose **Optional** to list it
without fetching it until someone installs it.

## After it's added

The desk becomes an ordinary dependency of the project, so it shows up
alongside your other dependencies and travels in the project's `flow.json`. The
help-desk button in the footer opens its guides, and questions you ask from
there reach the desk's own queue instead of Flowpad's.

## Good to know

- **Only the first desk answers.** If your project already has a help desk, a
  second one is added but doesn't take over — the original keeps receiving your
  requests. Flowpad tells you when this happens; remove the first desk if you
  want the new one to answer.
- **Not every repository is a desk.** If the one you point at has no help-desk
  manifest, Flowpad keeps it as a plain dependency and says so, so agents
  can still read it. There's a **Remove** button if that isn't what you
  wanted.
- **A desk keeps itself up to date.** It's a checkout of the publisher's
  repository, so pulling their changes brings new guides with it.
- **Branches are pinned.** Whatever branch you pick is the one that stays. To
  move a desk to a different branch, remove it and add it again.

See also: [[Dependencies]], [[Flowpad project]].
