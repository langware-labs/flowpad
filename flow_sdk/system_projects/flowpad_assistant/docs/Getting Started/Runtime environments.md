---
id: eb6fbdbc-e394-4c01-8998-ca662e2e98e2
title: Runtime environments
---

# Runtime environments

Flowpad runs in three different environments. The colored banner at the top of
the home page tells you which one you are looking at right now.

## Desktop — green banner

The Flowpad app running locally on your own computer. Your projects, files, and
agent sessions live on this machine, and the app talks to the hub only for
cloud features (sharing, conversations, sign-in). This is the everyday mode:
full local filesystem access, local compute, and the option to work fully
offline in Local privacy mode.

## Cloud Sandbox — blue banner

The same Flowpad app, but running inside a cloud sandbox (an E2B machine)
provisioned for you by the hub — for example when you open a cloud desktop
from the hub's home page. It looks and behaves like the desktop app, with two
differences: the files and compute live in the sandbox (not on your laptop),
and the sandbox pauses when unused. Anything you want to keep should be shared
or pushed to git before the sandbox is torn down.

## Hub — grey banner

The hub is Flowpad's shared server — the place where organizations, projects,
conversations, and members live. When you browse the hub directly in a
browser, you get the hub surface: your world graph, organization, projects,
and cloud desktops. There is no local filesystem here; it is the meeting point
that all desktop and sandbox instances connect to.

The banner is grey on the hub, flipping shade with your theme (dark grey in
light mode, light grey in dark mode), blue in a cloud sandbox, and green on
your own desktop.
