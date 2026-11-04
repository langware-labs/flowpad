import { JourneyGraph, registerMemoryJourney, type JourneyStep, type JourneyWaitCondition } from '@sdk';

/**
 * VIBE EXIT #1 — the session's mode switch.
 *
 * A probe journey: it exists to make one way OUT of the Vibe workspace visible
 * by having you take it. We are reviewing every exit case by case and deciding
 * which should stay, so these read as demonstrations, not onboarding.
 *
 * The shape every probe in this campaign follows: **get into a real workspace
 * first, then leave it.** Pointing at the exit control from an empty home proves
 * nothing — there is nothing on screen to lose. The loss is the point, so the
 * journey opens a live build (chat pane, display, its own tab strip), makes you
 * look at it, and only then takes the exit.
 *
 * The exit under review: the session's own switch (`SessionSurfaceSwitch`)
 * renders Vibe / Chat / Terminal side by side and always offers all three. A mode
 * belongs to a session tab (docs/viewmodes.md) and the home is always Vibe, so the
 * exit lives inside the build itself. A non-technical user is still one unlabelled click from losing
 * the workspace, with no confirmation and nothing naming what went.
 *
 * Written in code rather than as a `graph.json` folder because a probe is
 * rewritten as fast as we can look at it — see `MemoryJourney`.
 */

/** Commentary: nothing to do, nothing to wait for — Next is the only way on.
 *  `stay` because these steps talk about the surface already on screen. */
function step(node_id: string, name: string, status_line: string, over: Partial<JourneyStep> = {}): JourneyStep {
  return { node_id, name, status_line, present: { dock: { kind: 'stay' } }, ...over };
}

/**
 * A step that takes a real exit: Next presses the control, and the step does not
 * land until the app HAS changed.
 *
 * The gate is state ALONE, never the click. An occurrence only proves a button
 * was pressed — the loss this journey is about is the workspace actually going,
 * and those are ~100ms apart, which is exactly long enough for the tour to
 * narrate a loss that has not happened yet. State also survives the user getting
 * there another way (a shortcut, the back button).
 */
function exitStep(
  node_id: string,
  name: string,
  status_line: string,
  tag: string,
  becomes: JourneyWaitCondition,
): JourneyStep {
  return step(node_id, name, status_line, {
    present: { dock: { kind: 'stay' }, highlight: tag },
    // Next presses the control for you — a demonstration has to MOVE the app.
    // `becomes` is the gate on that same press, so the step cannot land claiming
    // a consequence it did not get.
    act: { kind: 'click', target: tag },
    waitFor: [becomes],
  });
}

export const VIBE_EXIT_MODE_SWITCH = new JourneyGraph({
  // The home has one look (Vibe); the mode lives on the build the user opens.
  start: { kind: 'root' },
  steps: [
    // ── in ──
    // The workspace is ON SCREEN when its display pane is — which is what this
    // step actually means, and is true however the user got there. The step
    // cannot open the build itself: a build's id cannot be authored. So the
    // user opens it, and the gate holds Next until the workspace is really up.
    step(
      'open_build',
      'Open a build',
      'Open one of your builds — from Chats, or its link. This is the real thing — an agent session, not a demo.',
      { waitFor: [{ element: { present: 'VibeDisplay' } }] },
    ),
    step(
      'look_at_it',
      'This is what you have',
      'Chat on the left, the live display on the right, and its own row of tabs above it. Everything the agent shows you appears in the ringed half.',
      { present: { dock: { kind: 'stay' }, highlight: 'VibeDisplay' } },
    ),

    // ── out ──
    exitStep(
      'leave',
      'Now take the exit',
      "Click the speech bubble in the session's switch — Chat. One click, no confirmation.",
      'ViewModeChat',
      // The workspace is really gone — not "they clicked the button".
      { element: { gone: 'VibeDisplay' } },
    ),
    // ── back ──
    // The loss and the way back are ONE step on purpose. Splitting them left a
    // Continue sitting between "look at what went" and "click the wand", and the
    // natural reaction to losing your workspace is to reach for the way back
    // immediately — which then did not advance the journey.
    exitStep(
      'landed',
      'Look at what went, then come back',
      'The display is gone. So is the tab strip above it. The build is still running — you just cannot see anything it produces, and nothing told you that. Click the wand to return; nothing on screen says that is the way home.',
      'ViewModeVibe',
      { element: { present: 'VibeDisplay' } },
    ),
    step(
      'verdict',
      'That was the whole exit',
      'One unlabelled click out, one back, no warning either way. Decide: keep it, hide it behind the double-click reveal Dev already uses, or drop it from Vibe entirely.',
    ),
  ],
});

registerMemoryJourney({
  name: 'vibe-exit-mode-switch',
  title: "Vibe exit — the session's mode switch",
  graph: VIBE_EXIT_MODE_SWITCH,
});
