---
id: 912cde4d-00b2-437e-93c8-d5a941c2fc1d
title: Where your assets live
---

# Where your assets live

Every asset in Flowpad carries a small badge showing where it can be reached.
It sits just left of the asset's type icon. Where the badge is a link, clicking
it takes you to that copy — in a list the badges are indicators only.

## The badges

### The local badge

A hard-drive glyph. This asset is a real file on this machine and nowhere else.
Click it to reveal the file in Finder or Explorer, exactly where it sits on
disk.

Most things start here. Notes you write, skills you author, a project you
created this morning — all local until you decide otherwise.

### The cloud badge

A cloud glyph. There is a copy of this asset on Flowpad cloud. Click it to open
that copy in your browser.

Read this one carefully: **it means "there is also a copy on the cloud", not
"this lives only on the cloud".** The file is still on your machine. The badge
is recording something that happened — you shared this, or someone shared it
with you — not moving it somewhere else.

### The git badge

A branch glyph, shown when the asset sits inside a git repository that has a
remote. Click it to open that exact file on GitHub, GitLab or Bitbucket, on the
branch you're currently on.

Git is a location in the same sense as the other two, but it is **your** repo,
not Flowpad's cloud. Sending work to a teammate through git is a different
route with different rules — see [[Git sharing]].

## How this relates to your privacy mode

The footer switch described in [[Data privacy modes]] is the valve. The badge
tells you which side of the valve a given asset already sits on.

- In **Connected** mode the valve is open. Nothing crosses on its own, but when
  you share something it gains a cloud copy — and its badge changes to say so.
- In **Local** mode the valve is shut. Nothing new can cross, and anything that
  crossed before stops being updated there.

**Switching to Local does not un-share anything.** Assets that already have a
cloud copy keep that copy and keep the cloud badge. The badge is being honest
about the past. What stops is traffic — your later edits stay on this machine,
so the two copies quietly drift apart until you switch back.
