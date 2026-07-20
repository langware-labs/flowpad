---
id: 6b431fc5-d31f-4295-9e5e-9958b6eea523
title: Asset improvement
version: 2
---

# Asset improvement

The **wand** next to an asset in the asset manager asks Flowpad to look at how that
asset actually behaved in this run, and then rewrite it to work better.

It only appears next to assets the run **used**. That is the whole idea: the
improvement is grounded in real evidence from this session's transcript, not in a
general opinion about the asset. An asset nothing touched has nothing to learn from
yet.

## What happens when you click it

Flowpad asks what you'd like to fix — a sentence is enough ("it keeps skipping the
tests", "the output format drifts"). You can also leave it blank and let the
analysis speak for itself. Then it runs two agents, back to back:

1. **Analyze.** The first agent reads this session's transcript and looks for
   moments where the asset misbehaved — instructions that were ignored, steps that
   went wrong, guidance that turned out to be ambiguous. It produces a list of
   findings tied to that asset.
2. **Correct.** The second agent takes those findings and edits the asset's file to
   address them.

When it finishes, the **Asset compare** view opens showing the proposed rewrite next
to the current version. Nothing is saved until you accept it.

## What it needs

* **A transcript.** The process must have run at least once — improvement reads the
  session, so a process that has not started yet has nothing to analyze.

* **A file to edit.** Assets with no file on disk (an inline persona, for example)
  can't be improved this way.

* **A clean asset.** If the asset has uncommitted edits, Flowpad asks before
  continuing, so an in-progress change isn't quietly overwritten.

## Good to know

* **It can come back empty.** If the analysis finds nothing asset-scoped to fix, it
  says so and stops rather than inventing a change. That's a real answer: the
  transcript didn't show the asset getting in the way.

* **You review every change.** The correction always lands in Asset compare. Flowpad
  never writes over an asset without showing you first.

* **Read-only assets get a copy.** If the asset lives outside this agent — in your
  user folder, in the project, or shipped with Flowpad — improving it doesn't touch
  the original. Attach it first to get a private copy this agent owns, and improve
  that.
