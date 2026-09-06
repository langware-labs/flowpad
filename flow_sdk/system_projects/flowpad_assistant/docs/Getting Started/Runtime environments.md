---
id: eb6fbdbc-e394-4c01-8998-ca662e2e98e2
title: Runtime environments
---

# Runtime environments

Flowpad runs in a few different environments. The colored chip in the
navigation bar tells you which one you are looking at right now.

## Desktop — green banner

The Flowpad app running locally on your own computer. Your projects, files, and
agent sessions live on this machine, and the app talks to the hub only for
cloud features (sharing, conversations, sign-in). This is the everyday mode:
full local filesystem access, local compute, and the option to work fully
offline in Local privacy mode.

## Local Browser — green banner

The same desktop Flowpad, opened in a browser tab instead of the desktop app
window: a local server on your own computer is serving the page, so your
projects, files, and agent sessions are still the ones on this machine. The
chip shows the desktop glyph with a small browser badge, and a darker green,
because it is the same machine seen through a different client. Everything the
desktop can do, this can do — only the window chrome differs.

## Cloud Sandbox — blue banner

The same Flowpad app, but running inside a cloud sandbox (an E2B machine)
provisioned for you by the hub — for example when you open a cloud desktop
from the hub's home page. It looks and behaves like the desktop app, with two
differences: the files and compute live in the sandbox (not on your laptop),
and the sandbox pauses when unused. Anything you want to keep should be shared
or pushed to git before the sandbox is torn down.

## Agent — purple banner

A cloud box that belongs to an agent rather than to you: the machine a deployed
agent runs on, opened so you can watch or steer it. The files and sessions in
it are the agent's own, so treat what you see as the agent's workspace, not a
copy of yours. The purple chip is the warning that you are on someone else's
machine.

## Hub — grey banner

The hub is Flowpad's shared server — the place where organizations, projects,
conversations, and members live. When you browse the hub directly in a
browser, you get the hub surface: your world graph, organization, projects,
and cloud desktops. There is no local filesystem here; it is the meeting point
that all desktop and sandbox instances connect to.

The chip is grey on the hub, flipping shade with your theme (dark grey in
light mode, light grey in dark mode), blue in a cloud sandbox, purple on an
agent's box, and green on your own desktop — two shades of green for the
desktop app and a local browser tab.
